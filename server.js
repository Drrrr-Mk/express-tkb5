const express = require('express');
const cloud = require('wx-server-sdk');

const app = express();
app.use(express.json());

// 初始化云能力（使用当前云托管环境下的云数据库/云存储）
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ===== 健康检查 / 联通测试 =====
app.post('/api/count', async (req, res) => {
  const { action } = req.body || {};
  // 示例：读写一个计数器
  const counter = db.collection('counters');
  try {
    if (action === 'inc') {
      const r = await counter.doc('main').get();
      const count = (r.data ? r.data.count : 0) + 1;
      await counter.doc('main').save({ data: { count } });
      return res.json({ ok: true, count });
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: false, msg: e.message });
  }
});

// ===== 生成好评文案 =====
app.post('/api/generate', async (req, res) => {
  const { category = '默认', useAI = false } = req.body || {};
  try {
    const types = ['opening', 'desc', 'feeling', 'recommend'];
    const parts = [];
    for (const t of types) {
      const r = await db.collection('templates')
        .where({ type: t, category, status: 'active' })
        .limit(50)
        .get();
      if (r.data && r.data.length) {
        parts.push(pickByWeight(r.data));
      }
    }
    let reviewText = parts.filter(Boolean).join('');

    // AI 润色（可选），需配置环境变量 AI_URL / AI_KEY
    if (useAI && process.env.AI_URL && process.env.AI_KEY) {
      try {
        const polished = await polishWithAI(reviewText, category);
        if (polished) reviewText = polished;
      } catch (e) { /* 回退模板原文 */ }
    }

    // 记录生成历史
    try {
      await db.collection('records').add({
        data: { reviewText, category, useAI: !!useAI, createdAt: db.serverDate() }
      });
    } catch (e) {}

    res.json({ ok: true, reviewText });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ===== 分页拉取好评照片（含可下载URL） =====
app.post('/api/photos', async (req, res) => {
  const { page = 0, pageSize = 20, category = '' } = req.body || {};
  try {
    const where = { status: 'active' };
    if (category) where.category = category;

    const r = await db.collection('photos')
      .where(where)
      .orderBy('createdAt', 'desc')
      .skip(page * pageSize)
      .limit(pageSize)
      .get();

    const list = r.data || [];
    // 批量换取临时可下载 URL
    if (list.length) {
      const { fileList: urls } = await cloud.getTempFileURL({
        fileList: list.map((p) => p.fileID)
      });
      list.forEach((p, i) => { p.url = urls[i] ? urls[i].tempFileURL : ''; });
    }

    res.json({ ok: true, list });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ===== 照片记录入库 =====
app.post('/api/photo', async (req, res) => {
  const { fileID, category = '默认', tags = [] } = req.body || {};
  if (!fileID) return res.json({ ok: false, msg: '缺少 fileID' });
  try {
    const r = await db.collection('photos').add({
      data: { fileID, category, tags, status: 'active', createdAt: db.serverDate() }
    });
    res.json({ ok: true, id: r._id });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// 按权重抽取模板
function pickByWeight(rows) {
  if (!rows || !rows.length) return '';
  const total = rows.reduce((s, r) => s + (r.weight || 1), 0);
  let rand = Math.random() * total;
  for (const r of rows) {
    rand -= (r.weight || 1);
    if (rand <= 0) return r.content;
  }
  return rows[0].content;
}

async function polishWithAI(text, category) {
  const resp = await fetch(process.env.AI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.AI_KEY}`
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || 'default',
      messages: [
        { role: 'system', content: '你是一个口碑文案润色助手，保持原意、更自然口语化，输出纯净文案不添加多余符号。' },
        { role: 'user', content: `类目：${category}。请润色：${text}` }
      ]
    })
  });
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message.content) || '';
}

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log('container-service listening on', PORT);
});