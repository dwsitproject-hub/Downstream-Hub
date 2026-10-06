/**
 * Express app (no listen). Used by server.js and by tests.
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const authRoutes = require('./routes/auth');
const applicationsRoutes = require('./routes/applications');
const allowedDomainsRoutes = require('./routes/allowedDomains');
const businessUnitsRoutes = require('./routes/businessUnits');
const usersRoutes = require('./routes/users');
const settingsRoutes = require('./routes/settings');
const ssoRoutes = require('./routes/sso');
const activityRoutes = require('./routes/activity');
const analyticsRoutes = require('./routes/analytics');

const app = express();
app.disable('x-powered-by');

if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

const allowedOrigins = (process.env.CORS_ORIGINS || process.env.PUBLIC_APP_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, false);
      if (allowedOrigins.length === 0 && process.env.NODE_ENV === 'test') return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json());
app.use(
  '/uploads',
  express.static(path.join(__dirname, '..', 'uploads'), {
    maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  })
);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'downstream-hub-api' });
});

app.use('/api/auth', authRoutes);
app.use('/api/applications', applicationsRoutes);
app.use('/api/allowed-domains', allowedDomainsRoutes);
app.use('/api/business-units', businessUnitsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/sso', ssoRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/analytics', analyticsRoutes);

module.exports = app;
