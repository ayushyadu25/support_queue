import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { api, getAuthToken, setAuthToken } from './api.js';

const MAX_PER_PAGE = 8;
const EMPTY_AI = { enabled: false, provider: 'Smart rules', model: null, fallback: false, warning: null };

function toLocalInputValue(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function defaultDue(problemType) {
  const hours = problemType === 'urgent' ? 2 : 24;
  return toLocalInputValue(new Date(Date.now() + hours * 60 * 60 * 1000));
}

function timeLabel(minutes) {
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const mins = absolute % 60;
  const duration = hours ? `${hours}h ${mins}m` : `${mins}m`;
  return minutes < 0 ? `${duration} overdue` : `${duration} left`;
}

function formatDue(date) {
  return new Intl.DateTimeFormat('en', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(date));
}

function initials(name) {
  return name.split(' ').map((word) => word[0]).join('').slice(0, 2).toUpperCase();
}

function QueueEmpty({ mode }) {
  const copy = {
    overdue: ['Nothing is overdue', 'Every active problem is still within its response promise.'],
    completed: ['No completed problems yet', 'Solved problems will appear in your completed folder.'],
    open: ['Your queue is clear', 'Create a problem and it will appear here, assigned only to you.']
  };
  return (
    <div className="empty-state">
      <div className="empty-orb">✓</div>
      <h2>{copy[mode]?.[0] || copy.open[0]}</h2>
      <p>{copy[mode]?.[1] || copy.open[1]}</p>
    </div>
  );
}

function PasswordField({ label, value, onChange, autoComplete, placeholder, minLength, required = false }) {
  const [isVisible, setIsVisible] = useState(false);
  return (
    <label className="field">
      {label}
      <span className="password-input">
        <input type={isVisible ? 'text' : 'password'} value={value} onChange={onChange} autoComplete={autoComplete} placeholder={placeholder} minLength={minLength} required={required} />
        <button type="button" className="password-toggle" onClick={() => setIsVisible((current) => !current)} aria-label={isVisible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} title={isVisible ? 'Hide password' : 'Show password'}>{isVisible ? '◉' : '👁'}</button>
      </span>
    </label>
  );
}

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'employee' });
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event) {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const result = mode === 'signup'
        ? await api.signUp(form)
        : await api.logIn({ email: form.email, password: form.password });
      setAuthToken(result.token);
      onAuthenticated(result.user);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand auth-brand"><span className="brand-mark">P</span><span>priority<span>desk</span></span></div>
        <p className="eyebrow">Private IT helpdesk</p>
        <h1>{mode === 'login' ? 'Welcome back' : 'Create your workspace'}</h1>
        <p className="auth-intro">{mode === 'login' ? 'Sign in with your email and password. Your saved account role controls the access you receive.' : form.role === 'hr' ? 'HR can review and manage every problem in the helpdesk.' : 'Your problems stay private to your account.'}</p>
        <div className="auth-tabs">
          <button className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setError(''); }}>Sign in</button>
          <button className={mode === 'signup' ? 'selected' : ''} onClick={() => { setMode('signup'); setError(''); }}>Sign up</button>
        </div>
        {mode === 'signup' && <div className="role-tabs" aria-label="Choose account type">
          <button type="button" className={form.role === 'employee' ? 'selected' : ''} onClick={() => update('role', 'employee')}><span>◉</span><strong>Employee</strong><small>My assigned problems</small></button>
          <button type="button" className={form.role === 'hr' ? 'selected' : ''} onClick={() => update('role', 'hr')}><span>▦</span><strong>HR</strong><small>All helpdesk problems</small></button>
        </div>}
        <form onSubmit={submit} className="auth-form">
          {mode === 'signup' && <label className="field">Your name<input value={form.name} onChange={(event) => update('name', event.target.value)} autoComplete="name" placeholder="Priya Sharma" required /></label>}
          <label className="field">Email address<input type="email" value={form.email} onChange={(event) => update('email', event.target.value)} autoComplete="email" placeholder="you@company.com" required /></label>
          <PasswordField label="Password" value={form.password} onChange={(event) => update('password', event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="At least 8 characters" minLength="8" required />
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button auth-submit" disabled={isSubmitting}>{isSubmitting ? 'Please wait…' : mode === 'login' ? 'Sign in →' : 'Create account →'}</button>
        </form>
        <p className="auth-security">Your account protects your assigned problems and completed work.</p>
      </section>
    </main>
  );
}

function TicketCard({ ticket, onMove, onStatus, disabled, canReorder }) {
  const { minutesLeft, isOverdue, keywordHits, aiScore } = ticket.queueSignals;
  const priority = ticket.problemType;
  return (
    <article className={`ticket ticket-${priority} ${isOverdue ? 'ticket-overdue' : ''}`}>
      <div className="ticket-priority-bar" />
      <div className="ticket-main">
        <div className="ticket-topline">
          <span className={`badge badge-${priority}`}>{priority}</span>
          {isOverdue && <span className="overdue-flag">Response overdue</span>}
          {ticket.status === 'in-progress' && <span className="status-flag">In progress</span>}
          {ticket.status === 'resolved' && <span className="resolved-flag">Completed</span>}
        </div>
        <h3>{ticket.title}</h3>
        <p className="ticket-description">{ticket.description || 'No additional details provided.'}</p>
        <div className="ticket-meta">
          <span><span className="meta-icon">⌁</span>{ticket.customer}</span>
          <span><span className="meta-icon">◉</span>{ticket.assignee}</span>
          <span className={isOverdue ? 'deadline-danger' : ''}><span className="meta-icon">◷</span>{formatDue(ticket.responseDueAt)}</span>
        </div>
      </div>
      <aside className="ticket-side">
        <div className={`countdown ${isOverdue ? 'countdown-danger' : ''}`}>
          <span>{ticket.status === 'resolved' ? 'Completed' : isOverdue ? 'Past promise' : 'Response window'}</span>
          <strong>{ticket.status === 'resolved' ? 'Solved' : timeLabel(minutesLeft)}</strong>
        </div>
        <div className="card-actions">
          {canReorder && <><button className="move-button" onClick={() => onMove(ticket._id, 'up')} disabled={disabled} aria-label={`Move ${ticket.title} up`}>↑</button><button className="move-button" onClick={() => onMove(ticket._id, 'down')} disabled={disabled} aria-label={`Move ${ticket.title} down`}>↓</button></>}
          <select className="status-select" value={ticket.status} aria-label={`Status for ${ticket.title}`} disabled={disabled} onChange={(event) => onStatus(ticket._id, event.target.value)}>
            <option value="open">Open</option>
            <option value="in-progress">In progress</option>
            <option value="resolved">Completed</option>
          </select>
        </div>
        {keywordHits > 0 && <span className="ai-signal">AI signal {aiScore}</span>}
      </aside>
    </article>
  );
}

function CreateTicket({ onCreate, isSaving }) {
  const [form, setForm] = useState({
    title: '', customer: '', description: '', problemType: 'urgent', status: 'open', responseDueAt: defaultDue('urgent')
  });
  const [formError, setFormError] = useState('');
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value, ...(key === 'problemType' ? { responseDueAt: defaultDue(value) } : {}) }));

  async function submit(event) {
    event.preventDefault();
    setFormError('');
    try {
      await onCreate({ ...form, responseDueAt: new Date(form.responseDueAt).toISOString() });
      setForm({ title: '', customer: '', description: '', problemType: 'urgent', status: 'open', responseDueAt: defaultDue('urgent') });
    } catch (error) {
      setFormError(error.message);
    }
  }

  return (
    <section className="create-layout">
      <div className="page-heading create-heading">
        <div><p className="eyebrow">Private queue intake</p><h1>Add a support problem</h1><p>This problem is automatically assigned to you. Only you can view or update it.</p></div>
        <div className="sla-explainer"><span className="sla-dot urgent-dot" /> Urgent: 2-hour response<span className="sla-dot normal-dot" /> Normal: 24-hour response</div>
      </div>
      <form className="ticket-form" onSubmit={submit}>
        <div className="form-section-label"><span>01</span> Problem details</div>
        <div className="form-grid">
          <label className="field field-wide">Problem title<input value={form.title} onChange={(event) => update('title', event.target.value)} placeholder="Laptop will not boot before client demo" required /></label>
          <label className="field field-wide">Customer<input value={form.customer} onChange={(event) => update('customer', event.target.value)} placeholder="Northstar Labs" required /></label>
          <label className="field field-wide">What is happening?<textarea value={form.description} onChange={(event) => update('description', event.target.value)} placeholder="Add context that helps you resolve it…" rows="4" /></label>
        </div>
        <div className="form-section-label"><span>02</span> Response promise</div>
        <div className="form-grid response-grid">
          <div className="field type-field">Problem type<div className="type-toggle">
            <button type="button" className={form.problemType === 'urgent' ? 'type-selected urgent-select' : ''} onClick={() => update('problemType', 'urgent')}><strong>Urgent</strong><small>Reply within 2 hours</small></button>
            <button type="button" className={form.problemType === 'normal' ? 'type-selected normal-select' : ''} onClick={() => update('problemType', 'normal')}><strong>Normal</strong><small>Reply within 1 day</small></button>
          </div></div>
          <label className="field">Response due by<input type="datetime-local" value={form.responseDueAt} onChange={(event) => update('responseDueAt', event.target.value)} required /></label>
        </div>
        {formError && <p className="form-error">{formError}</p>}
        <div className="form-footer"><p><span className="spark">✦</span> Breached SLAs are raised one priority level automatically, once per check.</p><button className="primary-button" type="submit" disabled={isSaving}>{isSaving ? 'Adding to queue…' : 'Add to my queue →'}</button></div>
      </form>
    </section>
  );
}

function UsersDirectory({ users, isLoading, onViewQueue }) {
  return (
    <section className="users-layout">
      <header className="topbar users-heading">
        <div className="page-heading"><p className="eyebrow">HR workspace</p><h1>All users <span>{users.length} accounts</span></h1><p>Every account and its assigned problem workload.</p></div>
      </header>
      <section className="users-panel">
        <div className="users-panel-head"><div><h2>Helpdesk accounts</h2><p>Live active, overdue, and completed counts.</p></div><span className="live-label"><i /> Live data</span></div>
        {isLoading ? <div className="loading"><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /> Loading users</div> : users.length ? <div className="users-table-wrap"><table className="users-table"><thead><tr><th>User</th><th>Role</th><th>Active</th><th>Overdue</th><th>Completed</th><th /></tr></thead><tbody>{users.map((account) => <tr key={account.id}><td><span className="user-avatar">{initials(account.name)}</span><span className="user-details"><strong>{account.name}</strong><small>{account.email}</small></span></td><td><span className={`role-badge role-${account.role}`}>{account.role === 'hr' ? 'HR' : 'Employee'}</span></td><td>{account.active}</td><td><span className={account.overdue ? 'overdue-count' : ''}>{account.overdue}</span></td><td>{account.completed}</td><td><button className="view-queue-button" onClick={() => onViewQueue(account)}>View problems →</button></td></tr>)}</tbody></table></div> : <QueueEmpty mode="open" />}
      </section>
    </section>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [pageView, setPageView] = useState('queue');
  const [tickets, setTickets] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: MAX_PER_PAGE, total: 0, totalPages: 1 });
  const [counts, setCounts] = useState({ all: 0, overdue: 0, mine: 0, completed: 0 });
  const [view, setView] = useState('open');
  const [sort, setSort] = useState('queue');
  const [customer, setCustomer] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [ai, setAi] = useState(EMPTY_AI);
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);

  useEffect(() => {
    if (!getAuthToken()) {
      setAuthReady(true);
      return;
    }
    api.getMe().then((data) => setUser(data.user)).catch(() => setAuthToken('')).finally(() => setAuthReady(true));
  }, []);

  const requestParams = useMemo(() => ({ page: pagination.page, limit: MAX_PER_PAGE, view, sort, customer, assigneeId: assigneeFilter?.id || '', refresh: refreshKey }), [pagination.page, view, sort, customer, assigneeFilter, refreshKey]);

  useEffect(() => {
    if (!user || pageView !== 'queue') return;
    let active = true;
    setIsLoading(true);
    api.getTickets(requestParams).then((data) => {
      if (!active) return;
      setTickets(data.tickets);
      setPagination(data.pagination);
      setCounts(data.counts);
      setAi(data.ai || EMPTY_AI);
      if (data.ai?.warning) setNotice(data.ai.warning);
    }).catch((error) => {
      if (!active) return;
      if (error.status === 401) { setAuthToken(''); setUser(null); }
      else setNotice(error.message);
    }).finally(() => active && setIsLoading(false));
    return () => { active = false; };
  }, [user, pageView, requestParams]);

  useEffect(() => {
    if (!user || user.role !== 'hr' || pageView !== 'users') return;
    let active = true;
    setUsersLoading(true);
    api.getUsers().then((data) => active && setUsers(data.users)).catch((error) => active && setNotice(error.message)).finally(() => active && setUsersLoading(false));
    return () => { active = false; };
  }, [user, pageView, refreshKey]);

  useEffect(() => {
    if (!user) return undefined;
    const socket = io({ auth: { token: getAuthToken() } });
    socket.on('queue:changed', (event) => {
      if (event.message) setNotice(event.message);
      else if (event.event === 'completed') setNotice('Problem moved to your completed folder.');
      setRefreshKey((current) => current + 1);
    });
    socket.on('connect_error', () => setNotice('Live updates are reconnecting. Your saved queue is still available.'));
    return () => socket.close();
  }, [user]);

  function changeView(next) {
    setPageView('queue');
    setView(next);
    setPagination((current) => ({ ...current, page: 1 }));
  }
  function changeSort(next) {
    setSort(next);
    setPagination((current) => ({ ...current, page: 1 }));
  }
  function updateCustomer(value) {
    setCustomer(value);
    setPagination((current) => ({ ...current, page: 1 }));
  }
  async function moveTicket(id, direction) {
    try {
      await api.moveTicket(id, direction);
      changeSort('queue');
      setRefreshKey((current) => current + 1);
      setNotice('Manual queue order updated.');
    } catch (error) { setNotice(error.message); }
  }
  async function updateStatus(id, status) {
    try {
      await api.updateTicket(id, { status });
      setRefreshKey((current) => current + 1);
      setNotice(status === 'resolved' ? 'Problem moved to your completed folder.' : 'Ticket status updated.');
    } catch (error) { setNotice(error.message); }
  }
  async function createTicket(ticket) {
    setIsSaving(true);
    try {
      await api.createTicket(ticket);
      setPageView('queue');
      changeView('open');
      changeSort('ai');
      setRefreshKey((current) => current + 1);
      setNotice('Problem added to your private queue.');
    } finally { setIsSaving(false); }
  }
  function signOut() {
    setAuthToken('');
    setUser(null);
    setTickets([]);
    setUsers([]);
    setNotice('');
  }

  const rangeStart = pagination.total ? (pagination.page - 1) * pagination.limit + 1 : 0;
  const rangeEnd = Math.min(pagination.page * pagination.limit, pagination.total);
  const isHr = user?.role === 'hr';
  const heading = view === 'completed' ? 'Completed problems' : view === 'overdue' ? 'Overdue problems' : isHr ? 'All active problems' : 'My active problems';

  if (!authReady) return <main className="auth-page"><div className="loading auth-loading"><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /> Opening PriorityDesk</div></main>;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;

  function viewUserQueue(name) {
    setCustomer('');
    setAssigneeFilter(name);
    setPageView('queue');
    changeView('open');
    setNotice(`Showing problems assigned to ${name.name}.`);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">P</span><span>priority<span>desk</span></span></div>
        <p className="workspace-label">{isHr ? 'HR HELP DESK' : 'MY IT HELP DESK'}</p>
        <nav>
          <button className={pageView === 'queue' && view !== 'completed' ? 'nav-item active' : 'nav-item'} onClick={() => changeView('open')}><span>▤</span>{isHr ? 'All problems' : 'My queue'} <b>{counts.all}</b></button>
          <button className={pageView === 'queue' && view === 'completed' ? 'nav-item active' : 'nav-item'} onClick={() => changeView('completed')}><span>✓</span>Completed <b>{counts.completed}</b></button>
          {isHr && <button className={pageView === 'users' ? 'nav-item active' : 'nav-item'} onClick={() => setPageView('users')}><span>♙</span>All users <b>{users.length || '·'}</b></button>}
          <button className={pageView === 'new' ? 'nav-item active' : 'nav-item'} onClick={() => setPageView('new')}><span>＋</span>New problem</button>
          <button className="nav-item logout-item" onClick={signOut}><span>↗</span>Log out</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="presence"><span className="presence-dot" /> Live updates on</div>
          <div className="profile"><div>{initials(user.name)}</div><span><strong>{user.name}</strong><small>{isHr ? 'HR · all problems' : user.email}</small></span></div>
        </div>
      </aside>
      <main className="main-content">
        {pageView === 'new' ? <CreateTicket onCreate={createTicket} isSaving={isSaving} /> : pageView === 'users' && isHr ? <UsersDirectory users={users} isLoading={usersLoading} onViewQueue={viewUserQueue} /> : <>
          <header className="topbar">
            <div className="page-heading"><p className="eyebrow">{isHr ? 'HR workspace' : 'Your private workspace'}</p><h1>{view === 'completed' ? 'Completed folder' : isHr ? 'All support problems' : 'My support queue'} <span>{view === 'completed' ? `${counts.completed} solved` : `${counts.all} active`}</span></h1><p>{isHr ? 'You can view and manage every helpdesk problem.' : 'Only problems assigned to you appear here.'}</p></div>
            <button className="primary-button top-add" onClick={() => setPageView('new')}>＋ Add problem</button>
          </header>
          <section className="metrics">
            <button className={`metric ${view === 'overdue' ? 'metric-selected red' : 'red'}`} onClick={() => changeView('overdue')}><span className="metric-icon">!</span><span><small>NEEDS ATTENTION</small><strong>{counts.overdue} overdue</strong><em>View overdue →</em></span></button>
            <button className={`metric ${view === 'open' ? 'metric-selected blue' : 'blue'}`} onClick={() => changeView('open')}><span className="metric-icon">◉</span><span><small>{isHr ? 'WHOLE HELPDESK' : 'MY WORK'}</small><strong>{counts.mine} {isHr ? 'active for everyone' : 'assigned to me'}</strong><em>{isHr ? 'Show all problems →' : 'Show my queue →'}</em></span></button>
            <button className={`metric guidance ${view === 'completed' ? 'metric-selected' : ''}`} onClick={() => changeView('completed')}><span className="metric-icon">✓</span><span><small>COMPLETED FOLDER</small><strong>{counts.completed} problems solved</strong><em>View completed →</em></span></button>
          </section>
          <section className="queue-panel">
            <div className="queue-panel-head"><div><h2>{assigneeFilter ? `${assigneeFilter.name}'s problems` : heading}</h2><p>{pagination.total} matching problem{pagination.total === 1 ? '' : 's'} · Page {pagination.page} of {pagination.totalPages}</p></div><div className="search-wrap"><span>⌕</span><input value={customer} onChange={(event) => updateCustomer(event.target.value)} placeholder="Find customer or ticket" /></div></div>
            <div className="controls-row">
              <div className="view-tabs">
                <button className={view === 'open' ? 'selected' : ''} onClick={() => changeView('open')}>Open queue</button>
                <button className={view === 'overdue' ? 'selected' : ''} onClick={() => changeView('overdue')}>Overdue <span>{counts.overdue}</span></button>
                <button className={view === 'completed' ? 'selected' : ''} onClick={() => changeView('completed')}>Completed <span>{counts.completed}</span></button>
                {assigneeFilter && <button className="filter-pill" onClick={() => { setAssigneeFilter(null); setPagination((current) => ({ ...current, page: 1 })); }}>Assigned: {assigneeFilter.name} ×</button>}
              </div>
              <div className="sort-controls" aria-label="Sort queue">
                <span>Sort by</span><button className={sort === 'queue' ? 'sort-selected' : ''} onClick={() => changeSort('queue')}>↕ Manual queue</button><button className={sort === 'time' ? 'sort-selected' : ''} onClick={() => changeSort('time')}>◷ Time left</button><button className={sort === 'priority' ? 'sort-selected' : ''} onClick={() => changeSort('priority')}>! Urgent first</button><button className={sort === 'normal' ? 'sort-selected' : ''} onClick={() => changeSort('normal')}>○ Normal first</button><button className={`ai-sort ${sort === 'ai' ? 'sort-selected' : ''}`} onClick={() => changeSort('ai')}>✦ AI triage{ai.enabled ? ' · OpenAI' : ''}</button>
              </div>
            </div>
            {notice && <div className={`notice ${notice.includes('could not') || notice.includes('missing') ? 'notice-error' : ''}`}>{notice}</div>}
            <div className="tickets-list">{isLoading ? <div className="loading"><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /> Loading your private queue</div> : tickets.length ? tickets.map((ticket) => <TicketCard key={ticket._id} ticket={ticket} onMove={moveTicket} onStatus={updateStatus} disabled={isSaving} canReorder={view !== 'completed'} />) : <QueueEmpty mode={view} />}</div>
            <footer className="pagination"><span>{pagination.total ? `Showing ${rangeStart}–${rangeEnd} of ${pagination.total}` : 'No matching problems'}</span><div><button onClick={() => setPagination((current) => ({ ...current, page: Math.max(1, current.page - 1) }))} disabled={pagination.page === 1 || isLoading}>← Previous</button><button onClick={() => setPagination((current) => ({ ...current, page: Math.min(pagination.totalPages, current.page + 1) }))} disabled={pagination.page === pagination.totalPages || isLoading}>Next →</button></div></footer>
          </section>
        </>}
      </main>
    </div>
  );
}

export default App;
