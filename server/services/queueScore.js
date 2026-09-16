const emergencyWords = [
  'demo', 'client', 'cannot boot', "can't boot", 'down', 'outage', 'blocked',
  'security', 'locked out', 'locked-out', 'vpn', 'production', 'urgent'
];

export function getTicketSignals(ticket, now = new Date()) {
  const dueAt = new Date(ticket.responseDueAt);
  const minutesLeft = Math.round((dueAt.getTime() - now.getTime()) / 60000);
  const isOverdue = minutesLeft < 0;
  const text = `${ticket.title} ${ticket.description}`.toLowerCase();
  const keywordHits = emergencyWords.filter((word) => text.includes(word)).length;
  const priorityScore = ticket.problemType === 'urgent' ? 55 : ticket.problemType === 'high' ? 38 : 20;
  const overdueScore = isOverdue ? 1000 + Math.min(Math.abs(minutesLeft), 720) : 0;
  const deadlineScore = isOverdue ? 0 : Math.max(0, 360 - Math.min(minutesLeft, 360));
  const aiScore = overdueScore + priorityScore + deadlineScore + keywordHits * 18;

  return { minutesLeft, isOverdue, keywordHits, aiScore };
}

export function decorateTicket(ticket) {
  const plain = typeof ticket.toObject === 'function' ? ticket.toObject() : ticket;
  return { ...plain, queueSignals: getTicketSignals(plain) };
}

export function comparator(sortMode) {
  return (a, b) => {
    const aSignals = getTicketSignals(a);
    const bSignals = getTicketSignals(b);

    if (aSignals.isOverdue !== bSignals.isOverdue) return aSignals.isOverdue ? -1 : 1;

    if (sortMode === 'ai') return bSignals.aiScore - aSignals.aiScore || a.queueOrder - b.queueOrder;
    if (sortMode === 'priority') {
      const priorityOrder = { urgent: 0, high: 1, normal: 2 };
      const priorityDiff = priorityOrder[a.problemType] - priorityOrder[b.problemType];
      return priorityDiff || aSignals.minutesLeft - bSignals.minutesLeft || a.queueOrder - b.queueOrder;
    }
    if (sortMode === 'normal') {
      const priorityDiff = (a.problemType === 'normal' ? 0 : 1) - (b.problemType === 'normal' ? 0 : 1);
      return priorityDiff || aSignals.minutesLeft - bSignals.minutesLeft || a.queueOrder - b.queueOrder;
    }
    if (sortMode === 'time') return aSignals.minutesLeft - bSignals.minutesLeft || a.queueOrder - b.queueOrder;
    return a.queueOrder - b.queueOrder || aSignals.minutesLeft - bSignals.minutesLeft;
  };
}
