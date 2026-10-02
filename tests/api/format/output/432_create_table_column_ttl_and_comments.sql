CREATE TABLE anon.user_sessions
(
    `session_id` UUID COMMENT 'session key',
    `email`      String COMMENT 'monthly' TTL created + toIntervalDay(30),
    `ip`         IPv6 TTL created + toIntervalDay(7),
    `created`    DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY (created, session_id)
COMMENT 'web sessions'