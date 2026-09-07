# Dispatch Register — AWS PostgreSQL setup

The app now uses a Node.js API and PostgreSQL. The browser never receives the
database password or connects to RDS directly.

## 1. Create AWS PostgreSQL

Create an Amazon RDS for PostgreSQL database, or use another AWS-hosted
PostgreSQL service. Make sure the database security group allows connections
from the machine/container running this app on port `5432`.

Create a database and application user. Do not use the RDS master user for the
application in production.

## 2. Create the tables

Run [`schema.sql`](./schema.sql) against the database. For example:

```bash
psql "postgresql://USER:PASSWORD@RDS-ENDPOINT:5432/DATABASE" -f schema.sql
```

If your password contains characters such as `@`, `:`, `/`, or `#`, URL-encode
them in `DATABASE_URL`.

## 3. Configure and run the app

Install Node.js 18 or newer, then from this folder:

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL=postgresql://dispatch_app:YOUR_PASSWORD@YOUR_RDS_ENDPOINT:5432/dispatch_register
PGSSL=true
PGSSL_REJECT_UNAUTHORIZED=false
JWT_SECRET=use-a-long-random-secret
PORT=8000
NODE_ENV=development
COOKIE_SECURE=false
```

Start it:

```bash
npm start
```

Open <http://localhost:8000>.

For production, set `NODE_ENV=production`, use HTTPS behind your load balancer,
set `COOKIE_SECURE=true`, and configure AWS RDS CA verification instead of
`PGSSL_REJECT_UNAUTHORIZED=false`.

## 4. Create the first admin account

With `.env` configured, run:

```bash
npm run create-user -- admin@yourcompany.in "InitialPasswordHere" "Your Name" admin
```

Create staff accounts the same way, using `staff` as the final argument:

```bash
npm run create-user -- staff@yourcompany.in "StaffPasswordHere" "Staff Name" staff
```

The password is hashed with bcrypt and is never stored in plain text. To reset
a password, run `create-user` again for that email with a new password.

## 5. Optional courier tracking

The tracking API key stays on the server. Add these values to `.env` if needed:

```env
TRACK_PROVIDER=aftership
TRACK_API_KEY=your-provider-key
```

`trackingmore` is also supported. The app can otherwise run with manual delivery
statuses and no tracking key.

## 6. Deploy on AWS

The repository includes [`Dockerfile`](./Dockerfile) for ECS/EC2 and
[`apprunner.yaml`](./apprunner.yaml) for AWS App Runner. App Runner is the
simplest option for this single Node service.

### App Runner

1. Push this folder to a Git repository or create an App Runner source-code service.
2. Select **Node.js 22** and use the included `apprunner.yaml`.
3. Add `DATABASE_URL`, `JWT_SECRET`, `PGSSL=true`, and `COOKIE_SECURE=true` as
   App Runner runtime secrets/environment values. Keep `DATABASE_URL` and
   `JWT_SECRET` in AWS Secrets Manager or SSM Parameter Store.
4. Set the App Runner service's health check path to `/api/health`.
5. Put RDS and App Runner in a network configuration that permits the App Runner
   service to reach RDS on port `5432`. If RDS is private, configure an App Runner
   VPC connector and allow its security group in the RDS security group.
6. Run `schema.sql` once against RDS, then run `npm run create-user` locally with
   the RDS `DATABASE_URL` to create the first admin.

App Runner supplies the `PORT` environment variable automatically; the server
uses it and listens on port `8000` locally. See the [AWS App Runner Node.js
configuration guide](https://docs.aws.amazon.com/apprunner/latest/dg/service-source-code-nodejs.html)
for the current console/API options.

### ECS/Fargate or EC2

Build and publish the image to ECR, then run it with the same environment values:

```bash
docker build -t dispatch-register .
docker run --env-file .env -p 8000:8000 dispatch-register
```

For production, use an HTTPS load balancer, keep RDS private, and store secrets
outside the image. Amazon RDS supports SSL/TLS; when certificate verification is
enabled, provide the RDS CA bundle with `PGSSL_CA_PATH`.

### Single EC2 instance

For a small internal deployment, [`infra/ec2-user-data.sh`](./infra/ec2-user-data.sh)
bootstraps Amazon Linux 2023 with local PostgreSQL, the Node API, and Nginx. It is
intended for one `t3.micro` instance. The launch process should restrict SSH to
your IP, allow HTTP on port 80, and use an EBS volume with regular backups.

After the instance finishes bootstrapping, SSH in and create the first admin:

```bash
cd /opt/dispatch-register
sudo -u dispatch npm run create-user -- admin@yourcompany.in 'Choose-a-strong-password' 'Your Name' admin
```

The deployment creates a local PostgreSQL database on the instance for the first
version. For production growth, move the database to private RDS and change only
`DATABASE_URL`, `PGSSL`, and the server secret configuration.

## Architecture

```text
Browser → Node/Express API → AWS RDS PostgreSQL
                         └→ optional courier tracking API
```

The API enforces authentication, staff/admin permissions, server-side input
validation, and the unique invoice-number rule. Open register screens refresh
their data every 30 seconds so multiple staff members can work from the same
database.

## Existing Supabase data

This setup starts with an AWS PostgreSQL schema. Existing Supabase rows are not
copied automatically. Export the Supabase tables and transform/import them into
the corresponding AWS tables before switching staff to the new app.
