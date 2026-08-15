# UnoVelho

Base limpa do UnoVelho para Render + PostgreSQL.

## Segurança
Segredos ficam somente nas Environment Variables do Render. Nunca envie `.env`, `DATABASE_URL`, `JWT_SECRET` ou senha do administrador para o GitHub.

## Deploy
- Build Command: `npm install`
- Start Command: `npm start`
- Node: 20+

## Banco
O servidor cria apenas tabelas ausentes usando SQL compatível e não executa DROP/TRUNCATE. Para produção, `db/schema.sql` é a referência da estrutura.
