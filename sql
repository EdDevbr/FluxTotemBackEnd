
CREATE TABLE orders (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    external_ref VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'created',
    amount DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id BIGINT NOT NULL,
    provider VARCHAR(32) NOT NULL, -- 'mp_point'
    mp_order_id VARCHAR(64),
    status VARCHAR(32) NOT NULL DEFAULT 'created',
    terminal_id VARCHAR(64),
    raw_json JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders (id)
);