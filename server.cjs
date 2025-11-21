// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const app = express();

// ✅ 배포(HTTPS/리버스 프록시) 대비: secure 쿠키/리다이렉트 올바르게 동작
app.set('trust proxy', 1);

// ✅ CORS: origin 고정 + credentials 허용 (쿠키 전달을 위해 필수)
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true, // << 매우 중요
  })
);
// (선택) preflight 수동 허용
app.options('*', cors({ origin: CLIENT_URL, credentials: true }));

app.use(express.json());
app.use(cookieParser());
app.use(morgan('dev'));

// /api 프리픽스
const api = express.Router();

api.get('/issues', (req, res) => {
  res.json({
    items: [
      { id: 1, title: '언론 A: 이슈 1', summary: '요약...' },
      { id: 2, title: '언론 B: 이슈 2', summary: '요약...' },
    ],
  });
});

api.get('/agendas', (req, res) => {
  const { sort = 'recent' } = req.query;
  res.json({
    sort,
    items: [
      { id: 101, title: '핫 아젠다 1', upvotes: 42 },
      { id: 102, title: '핫 아젠다 2', upvotes: 31 },
    ],
  });
});

app.use('/api', api);

// 404
app.use((req, res) =>
  res.status(404).json({ error: 'Not found', path: req.path })
);

const PORT = process.env.PORT || 8000;
app.listen(PORT, () =>
  console.log(`✅ API server running on port ${PORT}`)
);
