let authToken = localStorage.getItem('prioritydesk-token') || '';

export function setAuthToken(token) {
  authToken = token || '';
  if (authToken) localStorage.setItem('prioritydesk-token', authToken);
  else localStorage.removeItem('prioritydesk-token');
}

export function getAuthToken() {
  return authToken;
}

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...options.headers
    },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || 'The queue could not be updated.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const api = {
  signUp: (details) => request('/auth/signup', { method: 'POST', body: JSON.stringify(details) }),
  logIn: (details) => request('/auth/login', { method: 'POST', body: JSON.stringify(details) }),
  getMe: () => request('/auth/me'),
  getUsers: () => request('/users'),
  getTickets: (params) => request(`/tickets?${new URLSearchParams(params)}`),
  createTicket: (ticket) => request('/tickets', { method: 'POST', body: JSON.stringify(ticket) }),
  updateTicket: (id, updates) => request(`/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  moveTicket: (id, direction) => request(`/tickets/${id}/move`, { method: 'POST', body: JSON.stringify({ direction }) })
};
