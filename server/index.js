import 'dotenv/config';
import http from 'http';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import mongoose from 'mongoose';
import { Server as SocketServer } from 'socket.io';
import { issueToken, publicUser, requireAuth, socketToken } from './auth.js';
import { Ticket } from './models/Ticket.js';
import { User } from './models/User.js';
import { aiStatus, rankWithOpenAI } from './services/aiTriage.js';
import { runEscalationCheck } from './services/escalation.js';
import { decorateTicket } from './services/queueScore.js';

// Kept as a single server entry point for the development watcher.
const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: true, methods: ['GET', 'POST', 'PATCH'] } });
const port = Number(process.env.PORT) || 5000;
const escalationInterval = Math.max(Number(process.env.ESCALATION_INTERVAL_MS) || 60_000, 60_000);
const currentFile = fileURLToPath(import.meta.url);
const serverDirectory = path.dirname(currentFile);
const clientBuildDirectory = path.resolve(serverDirectory, '../dist');

app.use(cors());
app.use(express.json());

const numberOrDefault = (value, fallback) => {
  const result = Number.parseInt(value, 10);
  return Number.isFinite(result) && result > 0 ? result : fallback;
};

function ticketRoom(userId) {
  return `user:${String(userId)}`;
}

function emitQueueChange(userId, event, ticket, extra = {}) {
  if (!userId) return;
  io.to(ticketRoom(userId)).to('hr').emit('queue:changed', {
    event,
    ticket: decorateTicket(ticket),
    occurredAt: new Date().toISOString(),
    ...extra
  });
}

function dueDateFromSla(problemType, responseDueAt) {
  if (responseDueAt) return new Date(responseDueAt);
  const hours = problemType === 'urgent' ? 2 : 24;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function validateTicket(body) {
  const errors = [];
  if (!body.title?.trim()) errors.push('A short problem title is required.');
  if (!body.customer?.trim()) errors.push('A customer name is required.');
  if (!['urgent', 'normal'].includes(body.problemType)) errors.push('Problem type must be urgent or normal.');
  if (!['open', 'in-progress', 'resolved'].includes(body.status || 'open')) errors.push('Invalid ticket status.');
  if (body.responseDueAt && Number.isNaN(new Date(body.responseDueAt).getTime())) errors.push('Response deadline is invalid.');
  return errors;
}

function sortStages(sortMode, now) {
  const riskWordPattern = "demo|client|cannot boot|can't boot|down|outage|blocked|security|locked out|locked-out|vpn|production|urgent";
  const signals = {
    $addFields: {
      isOverdue: { $cond: [{ $lt: ['$responseDueAt', now] }, 1, 0] },
      minutesLeft: { $dateDiff: { startDate: now, endDate: '$responseDueAt', unit: 'minute' } },
      priorityRank: {
        $switch: {
          branches: [
            { case: { $eq: ['$problemType', 'urgent'] }, then: 3 },
            { case: { $eq: ['$problemType', 'high'] }, then: 2 }
          ],
          default: 1
        }
      },
      normalRank: { $cond: [{ $eq: ['$problemType', 'normal'] }, 1, 0] },
      keywordHit: {
        $cond: [{
          $regexMatch: {
            input: { $concat: [{ $ifNull: ['$title', ''] }, ' ', { $ifNull: ['$description', ''] }] },
            regex: riskWordPattern,
            options: 'i'
          }
        }, 1, 0]
      }
    }
  };
  const aiScore = {
    $addFields: {
      aiQueueScore: {
        $add: [
          { $multiply: ['$isOverdue', 1000] },
          { $multiply: ['$priorityRank', 18] },
          { $multiply: ['$keywordHit', 18] },
          {
            $cond: [
              { $eq: ['$isOverdue', 1] },
              { $min: [{ $abs: '$minutesLeft' }, 720] },
              { $max: [0, { $subtract: [360, { $min: ['$minutesLeft', 360] }] }] }
            ]
          }
        ]
      }
    }
  };
  const sort = {
    queue: { isOverdue: -1, queueOrder: 1, responseDueAt: 1 },
    time: { isOverdue: -1, responseDueAt: 1, queueOrder: 1 },
    priority: { isOverdue: -1, priorityRank: -1, responseDueAt: 1, queueOrder: 1 },
    normal: { isOverdue: -1, normalRank: -1, responseDueAt: 1, queueOrder: 1 },
    ai: { isOverdue: -1, aiQueueScore: -1, responseDueAt: 1, queueOrder: 1 }
  };

  return [signals, aiScore, { $sort: sort[sortMode] || sort.queue }];
}

function isHr(user) {
  return user.role === 'hr';
}

function requireHr(request, response, next) {
  if (!isHr(request.user)) return response.status(403).json({ message: 'HR access is required to view all users.' });
  return next();
}

function ticketScope(user) {
  return isHr(user) ? {} : { assignedTo: new mongoose.Types.ObjectId(user._id) };
}

function userTicketQuery(user, { customer, view, assigneeId }) {
  const query = ticketScope(user);
  if (isHr(user) && assigneeId && mongoose.isObjectIdOrHexString(assigneeId)) {
    query.assignedTo = new mongoose.Types.ObjectId(assigneeId);
  }
  if (customer) {
    query.$or = [
      { customer: { $regex: customer, $options: 'i' } },
      { title: { $regex: customer, $options: 'i' } }
    ];
  }
  if (view === 'open') query.status = { $ne: 'resolved' };
  if (view === 'completed') query.status = 'resolved';
  if (view === 'overdue') {
    query.status = { $ne: 'resolved' };
    query.responseDueAt = { $lt: new Date() };
  }
  return query;
}

function signInResponse(user) {
  return { token: issueToken(user), user: publicUser(user) };
}

app.post('/api/auth/signup', async (request, response, next) => {
  try {
    const name = request.body.name?.trim();
    const email = request.body.email?.trim().toLowerCase();
    const password = request.body.password;
    const role = request.body.role || 'employee';
    if (!name || !email || !password) return response.status(400).json({ message: 'Name, email, and password are required.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return response.status(400).json({ message: 'Enter a valid email address.' });
    if (password.length < 8) return response.status(400).json({ message: 'Use a password with at least 8 characters.' });
    if (!['employee', 'hr'].includes(role)) return response.status(400).json({ message: 'Account type must be Employee or HR.' });
    const existing = await User.exists({ email });
    if (existing) return response.status(409).json({ message: 'An account already exists for that email. Please sign in.' });

    const user = await User.create({ name, email, role, passwordHash: await bcrypt.hash(password, 12) });
    return response.status(201).json(signInResponse(user));
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (request, response, next) => {
  try {
    const email = request.body.email?.trim().toLowerCase();
    const password = request.body.password || '';
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return response.status(401).json({ message: 'Incorrect email or password.' });
    }
    return response.json(signInResponse(user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth, (request, response) => response.json({ user: publicUser(request.user) }));
app.get('/api/health', (_request, response) => response.json({ ok: true }));
app.get('/api/ai/status', requireAuth, (_request, response) => response.json(aiStatus()));

app.get('/api/users', requireAuth, requireHr, async (_request, response, next) => {
  try {
    const users = await User.aggregate([
      {
        $lookup: {
          from: 'tickets',
          let: { userId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$assignedTo', '$$userId'] } } },
            {
              $group: {
                _id: null,
                active: { $sum: { $cond: [{ $ne: ['$status', 'resolved'] }, 1, 0] } },
                completed: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } },
                overdue: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'resolved'] }, { $lt: ['$responseDueAt', new Date()] }] }, 1, 0] } }
              }
            }
          ],
          as: 'ticketCounts'
        }
      },
      { $unwind: { path: '$ticketCounts', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          name: 1,
          email: 1,
          role: 1,
          createdAt: 1,
          active: { $ifNull: ['$ticketCounts.active', 0] },
          completed: { $ifNull: ['$ticketCounts.completed', 0] },
          overdue: { $ifNull: ['$ticketCounts.overdue', 0] }
        }
      },
      { $sort: { role: 1, name: 1 } }
    ]);
    return response.json({ users: users.map((user) => ({ ...user, id: String(user._id) })) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/tickets', requireAuth, async (request, response, next) => {
  try {
    const { customer, assigneeId, view = 'open', sort = 'queue' } = request.query;
    const query = userTicketQuery(request.user, { customer, assigneeId, view });
    const page = numberOrDefault(request.query.page, 1);
    const limit = Math.min(numberOrDefault(request.query.limit, 8), 50);
    const now = new Date();
    const start = (page - 1) * limit;
    const scope = ticketScope(request.user);
    const [queryTickets, total, all, overdue, mine, completed] = await Promise.all([
      Ticket.aggregate([{ $match: query }, ...sortStages(sort, now), { $skip: start }, { $limit: limit }]),
      Ticket.countDocuments(query),
      Ticket.countDocuments({ ...scope, status: { $ne: 'resolved' } }),
      Ticket.countDocuments({ ...scope, status: { $ne: 'resolved' }, responseDueAt: { $lt: now } }),
      Ticket.countDocuments({ ...scope, status: { $ne: 'resolved' } }),
      Ticket.countDocuments({ ...scope, status: 'resolved' })
    ]);
    const triage = sort === 'ai'
      ? await rankWithOpenAI(queryTickets)
      : { ...aiStatus(), tickets: queryTickets, fallback: false };

    response.json({
      tickets: triage.tickets.map(decorateTicket),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      counts: { all, overdue, mine, completed },
      ai: {
        enabled: triage.enabled,
        provider: triage.provider,
        model: triage.model,
        fallback: triage.fallback,
        warning: triage.warning || null
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tickets', requireAuth, async (request, response, next) => {
  try {
    const errors = validateTicket(request.body);
    if (errors.length) return response.status(400).json({ message: errors.join(' ') });

    const last = await Ticket.findOne({ assignedTo: request.user._id }).sort({ queueOrder: -1 }).lean();
    const ticket = await Ticket.create({
      title: request.body.title,
      customer: request.body.customer,
      description: request.body.description || '',
      problemType: request.body.problemType,
      assignee: request.user.name,
      assignedTo: request.user._id,
      status: request.body.status || 'open',
      responseDueAt: dueDateFromSla(request.body.problemType, request.body.responseDueAt),
      queueOrder: (last?.queueOrder || 0) + 1
    });
    emitQueueChange(request.user._id, 'created', ticket);
    return response.status(201).json({ ticket: decorateTicket(ticket) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/tickets/:id', requireAuth, async (request, response, next) => {
  try {
    const allowed = ['title', 'customer', 'description', 'status', 'responseDueAt'];
    const updates = Object.fromEntries(Object.entries(request.body).filter(([key]) => allowed.includes(key)));
    if (updates.status && !['open', 'in-progress', 'resolved'].includes(updates.status)) {
      return response.status(400).json({ message: 'Invalid ticket status.' });
    }
    const ticket = await Ticket.findOneAndUpdate(
      { _id: request.params.id, ...ticketScope(request.user) },
      updates,
      { new: true, runValidators: true }
    );
    if (!ticket) return response.status(404).json({ message: 'Ticket not found.' });
    emitQueueChange(ticket.assignedTo, ticket.status === 'resolved' ? 'completed' : 'updated', ticket);
    return response.json({ ticket: decorateTicket(ticket) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tickets/:id/move', requireAuth, async (request, response, next) => {
  try {
    const direction = request.body.direction;
    if (!['up', 'down'].includes(direction)) return response.status(400).json({ message: 'Direction must be up or down.' });
    const ticket = await Ticket.findOne({ _id: request.params.id, ...ticketScope(request.user) });
    if (!ticket) return response.status(404).json({ message: 'Ticket not found.' });

    const neighborQuery = direction === 'up'
      ? { assignedTo: ticket.assignedTo, queueOrder: { $lt: ticket.queueOrder }, status: { $ne: 'resolved' } }
      : { assignedTo: ticket.assignedTo, queueOrder: { $gt: ticket.queueOrder }, status: { $ne: 'resolved' } };
    const neighbor = await Ticket.findOne(neighborQuery).sort({ queueOrder: direction === 'up' ? -1 : 1 });
    if (!neighbor) return response.json({ ticket: decorateTicket(ticket), moved: false });

    const originalOrder = ticket.queueOrder;
    ticket.queueOrder = neighbor.queueOrder;
    neighbor.queueOrder = originalOrder;
    await Promise.all([ticket.save(), neighbor.save()]);
    emitQueueChange(ticket.assignedTo, 'reordered', ticket);
    return response.json({ ticket: decorateTicket(ticket), moved: true });
  } catch (error) {
    next(error);
  }
});

io.use(async (socket, next) => {
  try {
    const payload = socketToken(socket);
    const user = await User.findById(payload.sub).lean();
    if (!user) throw new Error('User not found.');
    socket.user = user;
    next();
  } catch (_error) {
    next(new Error('Authentication required.'));
  }
});

io.on('connection', (socket) => {
  socket.join(ticketRoom(socket.user._id));
  if (isHr(socket.user)) socket.join('hr');
});

if (process.env.NODE_ENV === 'production' && existsSync(clientBuildDirectory)) {
  app.use(express.static(clientBuildDirectory));
  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api')) return next();
    return response.sendFile(path.join(clientBuildDirectory, 'index.html'));
  });
}

app.use((error, _request, response, _next) => {
  console.error(error);
  if (error instanceof mongoose.Error.CastError) return response.status(400).json({ message: 'Invalid ticket ID.' });
  return response.status(500).json({ message: 'Something went wrong while updating the queue.' });
});

async function start() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is missing. Copy .env.example to .env and add your MongoDB Atlas URI.');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.warn('JWT_SECRET is missing. A temporary development secret will be used and sessions will reset after a server restart.');
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const checkSlaBreaches = () => runEscalationCheck((ticket, from) => {
    emitQueueChange(ticket.assignedTo, 'escalated', ticket, { fromPriority: from, message: `SLA breached: priority raised from ${from} to ${ticket.problemType}.` });
  }).catch((error) => console.error('SLA escalation check failed:', error.message));
  await checkSlaBreaches();
  setInterval(checkSlaBreaches, escalationInterval).unref();
  server.listen(port, '0.0.0.0', () => console.log(`PriorityDesk API ready on port ${port}; SLA checks every ${escalationInterval / 1000}s`));
}

start().catch((error) => {
  console.error('Could not connect to MongoDB Atlas:', error.message);
  process.exit(1);
});
