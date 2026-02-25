// server.js
// ✅ Ajustado para Docker Secret (mp_access_token), reforço de segurança e correções de robustez.
// - Lê token do MP via env ou /run/secrets/mp_access_token
// - CORS restrito (configurável)
// - Limite de body + headers básicos de segurança
// - Validações simples de input
// - Rate limit no webhook
// - Evita vazar detalhes internos em erros (mantém log no servidor)
// - Webhook com verificação opcional por SECRET (MP_WEBHOOK_SECRET)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const fs = require("fs");

const app = express();

/* =========================
   SECURITY / MIDDLEWARE
========================= */

// Se seu totem/app roda em um domínio específico, coloque em ALLOWED_ORIGINS:
// ex: "https://app.fluxpos.com.br,https://workflow.fluxpos.com.br"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

// CORS mais seguro (libera tudo só se você não definir ALLOWED_ORIGINS)
app.use(
    cors({
        origin: (origin, cb) => {
            if (!origin) return cb(null, true); // curl/postman/servidor
            if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
            return cb(null, ALLOWED_ORIGINS.includes(origin));
        },
        credentials: true,
    })
);

// Limita payload para evitar abuso
app.use(express.json({ limit: "200kb" }));

// Headers básicos (sem libs externas)
app.disable("x-powered-by");
app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
});

// Pequeno rate limit em memória p/ webhook (evita flood simples)
const webhookHits = new Map();
function webhookRateLimit(req, res, next) {
    const key = req.ip || "unknown";
    const now = Date.now();
    const win = 60_000; // 1 min
    const max = 120; // 120 req/min por IP
    const rec = webhookHits.get(key) || { t: now, n: 0 };
    if (now - rec.t > win) {
        rec.t = now;
        rec.n = 0;
    }
    rec.n += 1;
    webhookHits.set(key, rec);
    if (rec.n > max) return res.status(429).json({ ok: false });
    next();
}

/* =========================
   SECRETS / TOKENS
========================= */
function readSecretFile(path) {
    try {
        if (fs.existsSync(path)) {
            return fs.readFileSync(path, "utf8").trim();
        }
    } catch (_) { }
    return null;
}

function getMpToken() {
    // 1) ENV
    if (process.env.MP_ACCESS_TOKEN && process.env.MP_ACCESS_TOKEN.trim()) {
        return process.env.MP_ACCESS_TOKEN.trim();
    }
    // 2) Docker Secret (swarm)
    const fromSecret = readSecretFile("/run/secrets/mp_access_token");
    if (fromSecret) return fromSecret;

    // 3) (opcional) fallback para nome alternativo
    const alt = readSecretFile("/run/secrets/MP_ACCESS_TOKEN");
    if (alt) return alt;

    throw new Error("MP_ACCESS_TOKEN não encontrado (env ou /run/secrets/mp_access_token).");
}

function mpHeaders() {
    return {
        Authorization: `Bearer ${getMpToken()}`,
        "Content-Type": "application/json",
    };
}

function toAmountString(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error("amount inválido");
    return n.toFixed(2);
}

function safeExternalRef(v) {
    // conforme doc: letras, números, - e _
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (s.length < 1 || s.length > 64) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
    return s;
}

/* =========================
   MYSQL
========================= */
const db = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASS,
    database: process.env.MYSQL_DB,
    waitForConnections: true,
    connectionLimit: 10,
});

(async () => {
    try {
        const conn = await db.getConnection();
        console.log("✅ Conectado ao MySQL com sucesso!");
        conn.release();
    } catch (err) {
        console.error("❌ Erro ao conectar no MySQL:", err.message);
    }
})();

/* =========================
   AXIOS CLIENT
========================= */
const mpClient = axios.create({
    baseURL: "https://api.mercadopago.com",
    timeout: 15000,
});

/* =========================
   HEALTH
========================= */
app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "FluxTotemBackend", time: new Date().toISOString() });
});

/* =========================
   DB CHECK (cuidado: não exponha em produção)
========================= */
app.get("/db/check", async (_req, res) => {
    // ✅ Recomendo proteger por token em produção:
    // if (process.env.ADMIN_TOKEN && _req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) return res.sendStatus(403);

    try {
        const [dbName] = await db.query("SELECT DATABASE() AS db");
        const [tables] = await db.query("SHOW TABLES");
        res.json({ ok: true, db: dbName[0]?.db, tables });
    } catch (e) {
        res.status(500).json({ ok: false, message: "db_check_failed" });
    }
});

/* =========================
   DB INIT (cria tabelas) - inclui mp_payment_id
   ⚠️ Ideal: rodar 1 vez e remover/fechar este endpoint em produção
========================= */
app.post("/db/init", async (_req, res) => {
    // ✅ Recomendo proteger por token em produção:
    // if (process.env.ADMIN_TOKEN && _req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) return res.sendStatus(403);

    try {
        await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        external_ref VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'created',
        amount DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_orders_external_ref (external_ref)
      )
    `);

        await db.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        order_id BIGINT NOT NULL,
        provider VARCHAR(32) NOT NULL,
        mp_order_id VARCHAR(64),
        mp_payment_id VARCHAR(64),
        status VARCHAR(32) NOT NULL DEFAULT 'created',
        terminal_id VARCHAR(64),
        raw_json JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_payments_order_id (order_id),
        KEY idx_payments_mp_order_id (mp_order_id),
        FOREIGN KEY (order_id) REFERENCES orders(id)
      )
    `);

        res.json({ ok: true });
    } catch (e) {
        console.error("DB INIT ERROR:", e.message);
        res.status(500).json({ ok: false, message: "db_init_failed" });
    }
});

/* =========================
   CREATE ORDER (local)
========================= */
app.post("/orders", async (req, res) => {
    try {
        const externalRef = safeExternalRef(req.body?.externalRef);
        const amount = req.body?.amount;

        if (!externalRef || amount == null) {
            return res.status(400).json({ error: "externalRef e amount obrigatórios" });
        }

        const amountNum = Number(amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) {
            return res.status(400).json({ error: "amount inválido" });
        }

        const [r] = await db.execute(
            "INSERT INTO orders (external_ref, status, amount) VALUES (?, 'created', ?)",
            [externalRef, amountNum]
        );

        res.json({ orderId: r.insertId });
    } catch (e) {
        // Evita vazar info interna (mas loga no servidor)
        console.error("MYSQL ERROR /orders:", e.message);
        // Duplicate external_ref
        if (e.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ error: "externalRef já existe" });
        }
        res.status(500).json({ error: "mysql_error" });
    }
});

/* =========================
   ORDER STATUS (local + last payment)
========================= */
app.get("/orders/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "id inválido" });

        const [[ord]] = await db.execute("SELECT * FROM orders WHERE id = ?", [id]);
        if (!ord) return res.status(404).json({ error: "Order não encontrada" });

        const [[pay]] = await db.execute(
            "SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1",
            [id]
        );

        res.json({ order: ord, payment: pay || null });
    } catch (e) {
        res.status(500).json({ error: "server_error" });
    }
});

/* =========================
   LIST TERMINALS
========================= */
app.get("/mp/terminals", async (req, res) => {
    try {
        const { limit = 50, offset = 0, store_id, pos_id } = req.query;

        const qs = new URLSearchParams({
            limit: String(limit),
            offset: String(offset),
            ...(store_id ? { store_id: String(store_id) } : {}),
            ...(pos_id ? { pos_id: String(pos_id) } : {}),
        });

        const r = await axios.get(`https://api.mercadopago.com/terminals/v1/list?${qs.toString()}`, {
            headers: mpHeaders(),
            timeout: 15000,
        });

        res.json(r.data);
    } catch (e) {
        console.error("MP ERROR /mp/terminals:", e?.response?.data || e.message);
        res.status(500).json({ error: "mp_terminals_failed" });
    }
});

/* =========================
   SET PDV MODE
========================= */
app.patch("/mp/terminals/pdv", async (req, res) => {
    try {
        const terminalId = req.body?.terminalId;
        if (!terminalId || typeof terminalId !== "string") {
            return res.status(400).json({ error: "terminalId é obrigatório" });
        }

        const payload = { terminals: [{ id: terminalId, operating_mode: "PDV" }] };

        const r = await axios.patch("https://api.mercadopago.com/terminals/v1/setup", payload, {
            headers: mpHeaders(),
            timeout: 15000,
        });

        res.json(r.data);
    } catch (e) {
        console.error("MP ERROR /mp/terminals/pdv:", e?.response?.data || e.message);
        res.status(500).json({ error: "mp_set_pdv_failed" });
    }
});

/* =========================
   PAYMENT (POINT) - /v1/orders (CORRETO)
========================= */
app.post("/payments/point", async (req, res) => {
    try {
        const orderId = Number(req.body?.orderId);
        const terminalId = req.body?.terminalId;
        const title = req.body?.title;

        if (!Number.isFinite(orderId) || orderId <= 0 || !terminalId) {
            return res.status(400).json({ error: "orderId e terminalId obrigatórios" });
        }

        const [[ord]] = await db.execute("SELECT * FROM orders WHERE id = ?", [orderId]);
        if (!ord) return res.status(404).json({ error: "Order não encontrada" });

        const payload = {
            type: "point",
            external_reference: ord.external_ref,
            expiration_time: "PT10M",
            transactions: { payments: [{ amount: toAmountString(ord.amount) }] },
            config: {
                point: { terminal_id: terminalId, print_on_terminal: "no_ticket" },
            },
            description: typeof title === "string" && title.trim() ? title.trim() : `Pedido ${ord.external_ref}`,
        };

        const idempotencyKey = crypto.randomUUID();

        const r = await axios.post("https://api.mercadopago.com/v1/orders", payload, {
            headers: { ...mpHeaders(), "X-Idempotency-Key": idempotencyKey },
            timeout: 15000,
        });

        const mpOrderId = r.data?.id || "";
        const mpPaymentId = r.data?.transactions?.payments?.[0]?.id || "";
        const status = String(r.data?.status || "created");

        await db.execute(
            `INSERT INTO payments (order_id, provider, mp_order_id, mp_payment_id, status, terminal_id, raw_json)
       VALUES (?, 'mp_point_v1_orders', ?, ?, ?, ?, ?)`,
            [orderId, mpOrderId, mpPaymentId, status, String(terminalId), JSON.stringify(r.data)]
        );

        await db.execute("UPDATE orders SET status = 'awaiting_payment' WHERE id = ?", [orderId]);

        res.json({
            ok: true,
            provider: "mp_point_v1_orders",
            mp_order_id: mpOrderId,
            mp_payment_id: mpPaymentId,
            status,
            mpOrder: r.data,
        });
    } catch (e) {
        console.error("MP ERROR /payments/point:", e?.response?.data || e.message);
        res.status(500).json({ error: "mp_point_create_failed" });
    }
});

/* =========================
   GET MP ORDER STATUS (polling do app)
========================= */
app.get("/mp/orders/:mpOrderId", async (req, res) => {
    try {
        const { mpOrderId } = req.params;
        if (!mpOrderId || typeof mpOrderId !== "string") return res.status(400).json({ error: "mpOrderId inválido" });

        const r = await axios.get(`https://api.mercadopago.com/v1/orders/${mpOrderId}`, {
            headers: mpHeaders(),
            timeout: 15000,
        });

        res.json(r.data);
    } catch (e) {
        console.error("MP ERROR /mp/orders/:id:", e?.response?.data || e.message);
        res.status(500).json({ error: "mp_order_fetch_failed" });
    }
});

/* =========================
   CANCEL MP ORDER
========================= */
app.post("/mp/orders/:mpOrderId/cancel", async (req, res) => {
    try {
        const { mpOrderId } = req.params;
        if (!mpOrderId || typeof mpOrderId !== "string") return res.status(400).json({ error: "mpOrderId inválido" });

        const r = await axios.post(
            `https://api.mercadopago.com/v1/orders/${mpOrderId}/cancel`,
            {},
            { headers: { ...mpHeaders(), "X-Idempotency-Key": crypto.randomUUID() }, timeout: 15000 }
        );

        res.json(r.data);
    } catch (e) {
        console.error("MP ERROR cancel:", e?.response?.data || e.message);
        res.status(500).json({ error: "mp_order_cancel_failed" });
    }
});

/* =========================
   PIX (QR)
========================= */
app.post("/payments/pix", async (req, res) => {
    try {
        const orderId = Number(req.body?.orderId);
        const description = req.body?.description;

        if (!Number.isFinite(orderId) || orderId <= 0) return res.status(400).json({ error: "orderId obrigatório" });

        const [[ord]] = await db.execute("SELECT * FROM orders WHERE id = ?", [orderId]);
        if (!ord) return res.status(404).json({ error: "Order não encontrada" });

        const payload = {
            transaction_amount: Number(ord.amount),
            description: typeof description === "string" && description.trim()
                ? description.trim()
                : `Pedido ${ord.external_ref}`,
            payment_method_id: "pix",
            external_reference: ord.external_ref,
            notification_url: `${req.protocol}://${req.get("host")}/webhooks/mercadopago`,
            payer: { email: process.env.PIX_PAYER_EMAIL || "cliente@teste.com" },
        };

        const r = await axios.post("https://api.mercadopago.com/v1/payments", payload, {
            headers: mpHeaders(),
            timeout: 15000,
        });

        const paymentId = String(r.data?.id || "");
        const status = String(r.data?.status || "created");

        await db.execute(
            `INSERT INTO payments (order_id, provider, mp_order_id, mp_payment_id, status, terminal_id, raw_json)
       VALUES (?, 'pix', ?, ?, ?, NULL, ?)`,
            [orderId, paymentId, paymentId, status, JSON.stringify(r.data)]
        );

        await db.execute("UPDATE orders SET status = 'awaiting_payment' WHERE id = ?", [orderId]);

        res.json({
            ok: true,
            provider: "pix",
            paymentId,
            status,
            qr_code: r.data?.point_of_interaction?.transaction_data?.qr_code,
            qr_code_base64: r.data?.point_of_interaction?.transaction_data?.qr_code_base64,
            ticket_url: r.data?.point_of_interaction?.transaction_data?.ticket_url,
        });
    } catch (e) {
        console.error("MP ERROR /payments/pix:", e?.response?.data || e.message);
        res.status(500).json({ error: "pix_create_failed" });
    }
});

/* =========================
   WEBHOOK (PIX + opcional orders)
   - ACK rápido
   - rate limit simples
   - validação opcional via secret próprio:
     envie header: x-webhook-secret: <MP_WEBHOOK_SECRET>
========================= */
app.post("/webhooks/mercadopago", webhookRateLimit, async (req, res) => {
    res.status(200).json({ ok: true });

    try {
        const secret = process.env.MP_WEBHOOK_SECRET;
        if (secret) {
            const got = req.headers["x-webhook-secret"];
            if (got !== secret) {
                console.warn("Webhook: secret inválido");
                return;
            }
        }

        const body = req.body || {};
        const type = body.type || body.topic;
        const dataId = body?.data?.id || body?.id;

        if (!dataId) return;

        // PIX / payments
        if (type === "payment" || type === "payments") {
            const pr = await axios.get(`https://api.mercadopago.com/v1/payments/${dataId}`, {
                headers: mpHeaders(),
                timeout: 15000,
            });

            const payment = pr.data;
            const status = String(payment.status || "updated");
            const externalRef = payment.external_reference;

            await db.execute("UPDATE payments SET status = ?, raw_json = ? WHERE mp_order_id = ?", [
                status,
                JSON.stringify(payment),
                String(dataId),
            ]);

            if (status.toLowerCase() === "approved" && externalRef) {
                const [[ord]] = await db.execute("SELECT * FROM orders WHERE external_ref = ?", [externalRef]);
                if (ord?.id) await db.execute("UPDATE orders SET status = 'paid' WHERE id = ?", [ord.id]);
            }

            return;
        }

        // Se você configurar webhook para orders:
        // - você pode consultar /v1/orders/{id} e atualizar payments/orders
    } catch (e) {
        console.error("Webhook error:", e?.response?.data || e.message);
    }
});

/* =========================
   ERROR HANDLER GLOBAL
========================= */
app.use((err, _req, res, _next) => {
    console.error("GLOBAL ERROR:", err);
    res.status(500).json({ error: "server_error" });
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
    console.log(`🚀 Backend rodando em http://localhost:${PORT}`);
});