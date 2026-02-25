// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const mysql = require("mysql2/promise");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

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
   UTIL
========================= */
function mpHeaders() {
    return {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
    };
}

function toAmountString(v) {
    // MP Point /v1/orders pede 2 casas decimais como string
    return Number(v).toFixed(2);
}

const mpClient = axios.create({
    baseURL: "https://api.mercadopago.com",
    timeout: 15000,
});

/* =========================
   HEALTH
========================= */
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        service: "FluxTotemBackend",
        time: new Date().toISOString(),
    });
});

/* =========================
   DB CHECK
========================= */
app.get("/db/check", async (_req, res) => {
    try {
        const [dbName] = await db.query("SELECT DATABASE() AS db");
        const [tables] = await db.query("SHOW TABLES");
        res.json({ ok: true, db: dbName[0]?.db, tables });
    } catch (e) {
        res.status(500).json({ ok: false, message: e.message });
    }
});

/* =========================
   DB INIT (cria tabelas)
   - inclui mp_payment_id
========================= */
app.post("/db/init", async (_req, res) => {
    try {
        await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        external_ref VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'created',
        amount DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
        FOREIGN KEY (order_id) REFERENCES orders(id)
      )
    `);

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, message: e.message });
    }
});

/* =========================
   CREATE ORDER (local)
========================= */
app.post("/orders", async (req, res) => {
    try {
        const { externalRef, amount } = req.body || {};
        if (!externalRef || amount == null) {
            return res.status(400).json({
                error: "externalRef e amount obrigatórios",
                body: req.body,
            });
        }

        const [r] = await db.execute(
            "INSERT INTO orders (external_ref, status, amount) VALUES (?, 'created', ?)",
            [externalRef, amount]
        );

        res.json({ orderId: r.insertId });
    } catch (e) {
        console.error("MYSQL ERROR:", e);
        res.status(500).json({
            error: "Erro no MySQL",
            message: e.message,
            code: e.code,
        });
    }
});

/* =========================
   ORDER STATUS (local + last payment)
========================= */
app.get("/orders/:id", async (req, res) => {
    try {
        const id = req.params.id;

        const [[ord]] = await db.execute("SELECT * FROM orders WHERE id = ?", [id]);
        if (!ord) return res.status(404).json({ error: "Order não encontrada" });

        const [[pay]] = await db.execute(
            "SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1",
            [id]
        );

        res.json({ order: ord, payment: pay || null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* =========================
   LIST TERMINALS (doc correta)
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

        const r = await axios.get(
            `https://api.mercadopago.com/terminals/v1/list?${qs.toString()}`,
            { headers: mpHeaders(), timeout: 15000 }
        );

        res.json(r.data);
    } catch (e) {
        res.status(500).json({
            error: "Falha ao listar terminals",
            details: e?.response?.data || e.message,
        });
    }
});

/* =========================
   SET PDV MODE
========================= */
app.patch("/mp/terminals/pdv", async (req, res) => {
    try {
        const { terminalId } = req.body || {};
        if (!terminalId) return res.status(400).json({ error: "terminalId é obrigatório" });

        const payload = { terminals: [{ id: terminalId, operating_mode: "PDV" }] };

        const r = await axios.patch(
            "https://api.mercadopago.com/terminals/v1/setup",
            payload,
            { headers: mpHeaders(), timeout: 15000 }
        );

        res.json(r.data);
    } catch (e) {
        res.status(500).json({
            error: "Falha ao ativar PDV",
            details: e?.response?.data || e.message,
        });
    }
});

/* =========================
   PAYMENT (POINT) - CORRETO
   POST https://api.mercadopago.com/v1/orders
   - exige X-Idempotency-Key
========================= */
app.post("/payments/point", async (req, res) => {
    try {
        const { orderId, terminalId, title } = req.body || {};
        if (!orderId || !terminalId) {
            return res.status(400).json({ error: "orderId e terminalId obrigatórios" });
        }

        const [[ord]] = await db.execute("SELECT * FROM orders WHERE id = ?", [orderId]);
        if (!ord) return res.status(404).json({ error: "Order não encontrada" });

        const payload = {
            type: "point",
            external_reference: ord.external_ref,
            expiration_time: "PT10M",
            transactions: {
                payments: [{ amount: toAmountString(ord.amount) }],
            },
            config: {
                point: {
                    terminal_id: terminalId,
                    print_on_terminal: "no_ticket",
                },
                // Se quiser forçar tipo/parcelas, descomente:
                // payment_method: {
                //   default_type: "credit_card",
                //   default_installments: 1,
                //   installments_cost: "seller",
                // },
            },
            description: title || `Pedido ${ord.external_ref}`,
        };

        const r = await axios.post("https://api.mercadopago.com/v1/orders", payload, {
            headers: {
                ...mpHeaders(),
                "X-Idempotency-Key": crypto.randomUUID(),
            },
            timeout: 15000,
        });

        const mpOrderId = r.data?.id || "";
        const mpPaymentId = r.data?.transactions?.payments?.[0]?.id || "";
        const status = String(r.data?.status || "created");

        await db.execute(
            "INSERT INTO payments (order_id, provider, mp_order_id, mp_payment_id, status, terminal_id, raw_json) VALUES (?, 'mp_point_v1_orders', ?, ?, ?, ?, ?)",
            [orderId, mpOrderId, mpPaymentId, status, terminalId, JSON.stringify(r.data)]
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
        res.status(500).json({
            error: "Erro ao criar order /v1/orders (Point)",
            details: e?.response?.data || e.message,
        });
    }
});

/* =========================
   GET MP ORDER STATUS (polling do app)
========================= */
app.get("/mp/orders/:mpOrderId", async (req, res) => {
    try {
        const { mpOrderId } = req.params;

        const r = await axios.get(`https://api.mercadopago.com/v1/orders/${mpOrderId}`, {
            headers: mpHeaders(),
            timeout: 15000,
        });

        res.json(r.data);
    } catch (e) {
        res.status(500).json({ error: "Falha ao consultar order", details: e?.response?.data || e.message });
    }
});

/* =========================
   OPTIONAL: cancelar order Point (status created)
========================= */
app.post("/mp/orders/:mpOrderId/cancel", async (req, res) => {
    try {
        const { mpOrderId } = req.params;

        const r = await axios.post(
            `https://api.mercadopago.com/v1/orders/${mpOrderId}/cancel`,
            {},
            {
                headers: {
                    ...mpHeaders(),
                    "X-Idempotency-Key": crypto.randomUUID(),
                },
                timeout: 15000,
            }
        );

        res.json(r.data);
    } catch (e) {
        res.status(500).json({ error: "Falha ao cancelar order", details: e?.response?.data || e.message });
    }
});

/* =========================
   PIX (QR)
========================= */
app.post("/payments/pix", async (req, res) => {
    try {
        const { orderId, description } = req.body || {};
        if (!orderId) return res.status(400).json({ error: "orderId obrigatório" });

        const [[ord]] = await db.execute("SELECT * FROM orders WHERE id = ?", [orderId]);
        if (!ord) return res.status(404).json({ error: "Order não encontrada" });

        const payload = {
            transaction_amount: Number(ord.amount),
            description: description || `Pedido ${ord.external_ref}`,
            payment_method_id: "pix",
            external_reference: ord.external_ref,
            notification_url: `${req.protocol}://${req.get("host")}/webhooks/mercadopago`,
            payer: { email: "cliente@teste.com" },
        };

        const r = await axios.post("https://api.mercadopago.com/v1/payments", payload, {
            headers: mpHeaders(),
            timeout: 15000,
        });

        const paymentId = r.data?.id || "";
        const status = String(r.data?.status || "created");

        await db.execute(
            "INSERT INTO payments (order_id, provider, mp_order_id, mp_payment_id, status, terminal_id, raw_json) VALUES (?, 'pix', ?, ?, ?, NULL, ?)",
            [orderId, String(paymentId), String(paymentId), status, JSON.stringify(r.data)]
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
        res.status(500).json({ error: "Falha ao criar PIX", details: e?.response?.data || e.message });
    }
});

/* =========================
   WEBHOOK (PIX + POINT ORDER)
   - MP pode mandar topic/type
========================= */
app.post("/webhooks/mercadopago", async (req, res) => {
    // ACK rápido
    res.status(200).json({ ok: true });

    try {
        const body = req.body || {};
        const type = body.type || body.topic; // "payment" etc.
        const dataId = body?.data?.id || body?.id;

        if (!dataId) return;

        // 1) PIX / payments
        if (type === "payment" || type === "payments") {
            const pr = await axios.get(`https://api.mercadopago.com/v1/payments/${dataId}`, {
                headers: mpHeaders(),
                timeout: 15000,
            });

            const payment = pr.data;
            const status = String(payment.status || "updated");
            const externalRef = payment.external_reference;

            await db.execute(
                "UPDATE payments SET status = ?, raw_json = ? WHERE mp_order_id = ?",
                [status, JSON.stringify(payment), String(dataId)]
            );

            if (status.toLowerCase() === "approved" && externalRef) {
                const [[ord]] = await db.execute("SELECT * FROM orders WHERE external_ref = ?", [externalRef]);
                if (ord?.id) await db.execute("UPDATE orders SET status = 'paid' WHERE id = ?", [ord.id]);
            }

            return;
        }

        // 2) Se você configurar webhook para orders, dá pra consultar /v1/orders/{id} aqui também.
        // (Nem todo webhook vem assim; então deixamos como opcional.)
    } catch (e) {
        console.error("Webhook error:", e?.response?.data || e.message);
    }
});

/* =========================
   ERROR HANDLER GLOBAL
========================= */
app.use((err, _req, res, _next) => {
    console.error("GLOBAL ERROR:", err);
    res.status(500).json({ error: err.message });
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
    console.log(`🚀 Backend rodando em http://localhost:${PORT}`);
});