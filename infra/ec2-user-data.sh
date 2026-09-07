#!/bin/bash
set -euxo pipefail

exec > >(tee -a /var/log/dispatch-register-bootstrap.log | logger -t dispatch-register-bootstrap -s 2>/dev/console) 2>&1

APP_DIR=/opt/dispatch-register
APP_USER=dispatch
DB_NAME=dispatch_register
DB_USER=dispatch_app
NODE_VERSION=v22.14.0
REPO_URL=https://github.com/akshayagrg147/dispatch_tracker.git

dnf update -y
dnf install -y git nginx postgresql15-server postgresql15 openssl tar xz

if [ ! -s /var/lib/pgsql/data/PG_VERSION ]; then
  /usr/bin/postgresql-setup --initdb
fi
systemctl enable --now postgresql

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
fi

if [ ! -x /usr/local/bin/node ]; then
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz
  rm -rf /opt/node
  tar -xJf /tmp/node.tar.xz -C /opt
  mv "/opt/node-${NODE_VERSION}-linux-x64" /opt/node
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
fi

DB_PASSWORD=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)

if ! runuser -u postgres -- psql -tAc "select 1 from pg_roles where rolname='${DB_USER}'" | grep -q 1; then
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "create role ${DB_USER} login password '${DB_PASSWORD}'"
else
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "alter role ${DB_USER} with login password '${DB_PASSWORD}'"
fi

if ! runuser -u postgres -- psql -tAc "select 1 from pg_database where datname='${DB_NAME}'" | grep -q 1; then
  runuser -u postgres -- createdb -O "$DB_USER" "$DB_NAME"
else
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "alter database ${DB_NAME} owner to ${DB_USER}"
fi

runuser -u postgres -- psql "$DB_NAME" -v ON_ERROR_STOP=1 -f "$APP_DIR/schema.sql"
runuser -u postgres -- psql "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
grant connect on database ${DB_NAME} to ${DB_USER};
grant usage on schema public to ${DB_USER};
grant all privileges on all tables in schema public to ${DB_USER};
grant usage, select on all sequences in schema public to ${DB_USER};
grant execute on all functions in schema public to ${DB_USER};
alter default privileges for role postgres in schema public grant all privileges on tables to ${DB_USER};
alter default privileges for role postgres in schema public grant usage, select on sequences to ${DB_USER};
alter default privileges for role postgres in schema public grant execute on functions to ${DB_USER};
SQL

cat > "$APP_DIR/.env" <<EOF
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
PGSSL=false
JWT_SECRET=${JWT_SECRET}
PORT=8000
NODE_ENV=production
COOKIE_SECURE=false
EOF

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"
runuser -u "$APP_USER" -- env PATH="/opt/node/bin:/usr/local/bin:/usr/bin:/bin" npm ci --omit=dev

cat > /etc/systemd/system/dispatch-register.service <<EOF
[Unit]
Description=Dispatch Register Node application
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/node/bin/npm start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/nginx/conf.d/dispatch-register.conf <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

nginx -t
systemctl daemon-reload
systemctl enable --now dispatch-register
systemctl enable --now nginx

cat > /etc/dispatch-register-bootstrap-complete <<EOF
completed_at=$(date -Is)
app_dir=${APP_DIR}
db_name=${DB_NAME}
EOF
