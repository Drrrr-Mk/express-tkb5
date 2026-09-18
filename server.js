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

// ===== 好评模板库（内嵌种子数据） =====
const TEMPLATES = {
  默认: {
    opening: ["收到货第一时间就试用了，整体体验超出预期。", "物流很快，包装也很用心，开箱体验不错。"],
    desc: ["做工细节到位，材质摸起来很有质感，用起来很顺手。", "上手很简单，功能齐全，日常使用完全够用。"],
    feeling: ["性价比很高，这个价位能买到这种质量，非常满意。", "用了几天感觉很稳定，没有出现不舒服的地方。"],
    recommend: ["总体来说物有所值，值得回购！", "强烈推荐，闭眼入不踩雷。"],
  },
  食品: {
    opening: ["收到快递就迫不及待拆开尝了，包装很扎实没漏。", "下单次日就收到了，保质期新鲜，太贴心了。"],
    desc: ["口感很好，入口很新鲜，味道纯正，份量也足。", "配料干净，吃着放心，甜咸适中很合我口味。", "开袋就能闻到香味，解馋必备，回购首选。"],
    feeling: ["家里人都爱吃，一下子消灭干净了，还想着再买。", "比超市卖的还新鲜，这个价格太实惠。"],
    recommend: ["吃货必入，强烈推荐！", "会一直回购的好味道。"],
  },
  服装: {
    opening: ["上身版型超正，尺码标准，颜色没有色差。", "面料很舒服，摸起来质感在线，很满意。"],
    desc: ["剪裁利落，走线工整，细节处理得很好。", "透气性好，穿着轻便不闷热，日常很好搭。", "上身显瘦，垂感很棒，越穿越喜欢。"],
    feeling: ["穿着很舒服，朋友都说好看，问我要链接。", "这件质量对得起价格，做工没得挑。"],
    recommend: ["版型质量都在线，值得入手。", "显瘦又百搭，闭眼入！"],
  },
  数码: {
    opening: ["开箱很惊喜，包装严实，配件齐全。", "和描述的参数一致，上手一次就能操作。"],
    desc: ["运行流畅，反应灵敏，性能完全满足需求。", "做工精细，材质手感好，握持很舒服。", "功能丰富，续航给力，日常办公娱乐都够用。"],
    feeling: ["用了一周很稳定，没有卡顿或发热问题。", "这性能这个价位，性价比真的很高。"],
    recommend: ["数码好物，值得推荐。", "性能稳定不翻车，可以入。"],
  },
  美妆: {
    opening: ["外包装精致，很显档次，送礼也合适。", "下单后很快就到了，瓶口密封完好很放心。"],
    desc: ["质地清爽不油腻，上脸很容易推开。", "上色均匀，持妆效果不错，一天下来不脱。", "成分温和，敏感肌也能安心用，味道好闻。"],
    feeling: ["用了几天肤感很舒适，也没过敏，很安心。", "效果肉眼可见，性价比超高，会回购。"],
    recommend: ["好用不踩雷，强烈安利。", "值得回购的好产品。"],
  },
};

async function seedTemplates() {
  const col = db.collection('templates');
  const r = await col.count();
  if (r.total > 0) return { skipped: true, total: r.total };
  let inserted = 0;
  for (const [category, types] of Object.entries(TEMPLATES)) {
    for (const [type, contents] of Object.entries(types)) {
      for (const content of contents) {
        await col.add({
          data: { type, category, content, weight: 1, status: 'active', createdAt: db.serverDate() }
        });
        inserted++;
      }
    }
  }
  return { inserted };
}

// ===== 手动触发模板种子（幂等：已有数据则跳过） =====
app.post('/api/seed-templates', async (_req, res) => {
  try {
    const r = await seedTemplates();
    res.json({ ok: true, ...r });
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
app.listen(PORT, async () => {
  console.log('container-service listening on', PORT);
  // 启动时自动写入好评模板（已有则跳过）
  try {
    const r = await seedTemplates();
    console.log('[seed] templates ->', JSON.stringify(r));
  } catch (e) {
    console.error('[seed] failed:', e.message);
  }
});