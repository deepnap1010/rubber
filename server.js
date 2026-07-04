require('dotenv').config();
const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'sanmati';

// A machine is considered offline when no telemetry arrived within this window
const OFFLINE_AFTER_MS = 60 * 1000;

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Add it to .env');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });
let db;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// All registered machines, each joined with its most recent telemetry payload.
// The card UI is driven entirely by this response, so new machines that start
// reporting show up without any frontend change.
app.get('/api/machines', async (req, res) => {
  try {
    const machines = await db.collection('machines').find({}).toArray();

    const result = await Promise.all(
      machines.map(async (m) => {
        const latest = await db
          .collection('telemetries')
          .find({ machineId: m.machineId })
          .sort({ serverTs: -1 })
          .limit(1)
          .next();

        const data = (latest && latest.data) || {};
        const lastSeenAt = latest ? latest.serverTs : m.lastSeenAt || null;
        const ageMs = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() : Infinity;
        const online = ageMs < OFFLINE_AFTER_MS;

        return {
          machineId: m.machineId,
          machineName: m.machineName || m.machineId,
          machineType: data.type || m.machineType || 'Machine',
          dept: data.dept || '',
          online,
          status: online ? data.status || 'unknown' : 'offline',
          lastSeenAt,
          deviceTs: latest ? latest.deviceTs : null,
          payloadCount: m.payloadCount || 0,
          metrics: data,
        };
      })
    );

    res.json({ machines: result, serverTime: new Date().toISOString() });
  } catch (err) {
    console.error('GET /api/machines failed:', err);
    res.status(500).json({ error: 'Failed to load machines' });
  }
});

// Full detail for one machine: registration doc + latest telemetry payload
// (including raw PLC registers), used by the machine detail page.
app.get('/api/machines/:machineId', async (req, res) => {
  try {
    const m = await db.collection('machines').findOne({ machineId: req.params.machineId });
    if (!m) return res.status(404).json({ error: 'Machine not found' });

    const latest = await db
      .collection('telemetries')
      .find({ machineId: m.machineId })
      .sort({ serverTs: -1 })
      .limit(1)
      .next();

    const data = (latest && latest.data) || {};
    const lastSeenAt = latest ? latest.serverTs : m.lastSeenAt || null;
    const ageMs = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() : Infinity;
    const online = ageMs < OFFLINE_AFTER_MS;

    res.json({
      machineId: m.machineId,
      machineName: m.machineName || m.machineId,
      machineType: data.type || m.machineType || 'Machine',
      dept: data.dept || '',
      online,
      status: online ? data.status || 'unknown' : 'offline',
      lastSeenAt,
      deviceTs: latest ? latest.deviceTs : null,
      payloadCount: m.payloadCount || 0,
      registeredAt: m.registeredAt || m.createdAt || null,
      metricsSeen: m.metricsSeen || [],
      metrics: data,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/machines/:id failed:', err);
    res.status(500).json({ error: 'Failed to load machine' });
  }
});

// Recent telemetry points for one machine, used for the pressure trend sparkline.
app.get('/api/machines/:machineId/history', async (req, res) => {
  const minutes = Math.min(parseInt(req.query.minutes, 10) || 15, 180);
  const since = new Date(Date.now() - minutes * 60 * 1000);

  try {
    const docs = await db
      .collection('telemetries')
      .find({ machineId: req.params.machineId, serverTs: { $gte: since } })
      .sort({ serverTs: 1 })
      .project({ serverTs: 1, 'data.currentPressure': 1, 'data.curingTimeLeft': 1, 'data.status': 1 })
      .toArray();

    res.json({
      points: docs.map((d) => ({
        t: d.serverTs,
        pressure: d.data ? d.data.currentPressure ?? null : null,
        curingTimeLeft: d.data ? d.data.curingTimeLeft ?? null : null,
        status: d.data ? d.data.status ?? null : null,
      })),
    });
  } catch (err) {
    console.error('GET /api/machines/:id/history failed:', err);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// Recent telemetry records for the history table on the detail page —
// the raw documents as stored, minus the bulky register map.
app.get('/api/machines/:machineId/telemetry', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);
  try {
    const docs = await db
      .collection('telemetries')
      .find({ machineId: req.params.machineId })
      .sort({ serverTs: -1 })
      .limit(limit)
      .project({ serverTs: 1, deviceTs: 1, data: 1 })
      .toArray();

    res.json({
      records: docs.map((doc) => {
        const { rawRegisters, ...metrics } = doc.data || {};
        return { serverTs: doc.serverTs, deviceTs: doc.deviceTs, ...metrics };
      }),
    });
  } catch (err) {
    console.error('GET /api/machines/:id/telemetry failed:', err);
    res.status(500).json({ error: 'Failed to load telemetry' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Clean URL for the machine detail page: /machine/RUBBERMOLDING01
app.get('/machine/:machineId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'machine.html'));
});

(async () => {
  await client.connect();
  db = client.db(DB_NAME);
  app.listen(PORT, () => console.log(`Machine monitor running at http://localhost:${PORT}`));
})().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
