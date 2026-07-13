// Shared in-memory runtime state — read by the dashboard, never persisted
module.exports = {
  startedAt: Date.now(),
  waConnected: false,
  lastPollAt: 0,
  lastReading: null,
  lastError: null,
};
