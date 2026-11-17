# Deploy no Render

O serviço ainda não foi publicado por este ambiente. Estes são os passos para
você colocá-lo no ar na sua conta.

## 1. Publicar o repositório

Crie um repositório chamado **`roblox-web`** no GitHub e envie o conteúdo desta
pasta. Não inclua `node_modules`, `.env` nem chaves privadas.

Se estiver usando GitHub Desktop ou o site, o resultado esperado é:

```text
roblox-web/
├─ apps/
├─ server/
├─ tests/
├─ docs/
├─ package.json
└─ render.yaml
```

## 2. Criar o serviço

1. Abra o Dashboard do Render.
2. Clique em **New → Blueprint**.
3. Conecte sua conta GitHub e selecione **`roblox-web`**.
4. O Render detectará `render.yaml` automaticamente.
5. Confirme o serviço **roblox-web** e clique em **Apply/Deploy**.

Configuração do Blueprint:

```yaml
buildCommand: npm ci --prefix server
startCommand: npm start --prefix server
healthCheckPath: /health
```

A opção `starter` evita a suspensão por inatividade do plano gratuito. Você pode
mudar `plan` no `render.yaml` antes do deploy, se preferir.

## 3. Conferir o deploy

Abra:

```text
https://<seu-servico>.onrender.com/health
```

Resposta esperada:

```json
{"ok":true}
```

Depois abra a raiz:

```text
https://<seu-servico>.onrender.com/
```

## 4. Entrar no jogo

No Render, o fluxo automático de navegador fica desativado porque o servidor não
consegue abrir um Chrome no seu computador:

1. Proxy: `admin` / `admin` (sem preenchimento automático).
2. Cookie: valor de `.ROBLOSECURITY` da sua conta.
3. Place ID: o ID da experiência.
4. Clique em **Entrar no jogo**.

O cliente abre em `about:blank?placeId=...`. Permita a abertura da aba do cliente
ou use o botão **Abrir cliente** se o navegador bloqueá-la. A aba de Place ID
permanece aberta e é exibida novamente quando o cliente Roblox é encerrado.

Na execução **local**, abra `/`: o Node mostra o prompt nativo do proxy e depois
apresenta a página oficial da Roblox num **iframe proxy** na mesma raiz. O
formulário, captcha e 2FA funcionam no próprio navegador, sem colar cookie e sem
Chrome controlado. Os endereços `/login`, `/launch` e `/manual` são apenas
redirecionamentos de compatibilidade para `/`. Se a sessão expirar, o cliente
limpa o token e retorna automaticamente para `/?login=1`.

O cookie não deve ser colocado no repositório, no README ou em qualquer URL.
Ele atravessa HTTPS e fica somente na memória do processo do Render. Um restart
do serviço exige um novo login.

## 5. Trocar a senha do proxy (opcional)

Na sua máquina:

```bash
cd server
npm run hash -- meuusuario minhasenha
```

O comando imprime dois valores. No Render, abra **Environment** e atualize:

```text
PROXY_USERNAME_SCRYPT=<valor de PROXY_USERNAME_SCRYPT>
PROXY_PASSWORD_SCRYPT=<valor de PROXY_PASSWORD_SCRYPT>
```

Salve e faça **Manual Deploy → Deploy latest commit**. Não envie o hash para o
cliente; ele fica apenas no ambiente do servidor.

## 6. Solução de problemas

- **`SharedArrayBuffer` indisponível:** o servidor já envia COOP/COEP. Confira se
  acessou o domínio do Render, não uma página estática sem os headers.
- **401 no join:** sessão do proxy expirada ou cookie Roblox ausente/inválido.
- **403 no WebSocket:** o endpoint não veio do join da mesma sessão. Entre
  novamente no jogo em vez de alterar host/port manualmente.
- **Primeira abertura lenta:** pode ser cold start ou download do wasm. O plano
  `starter` evita suspensão por inatividade.
- **Health não responde:** veja os logs do build e confirme que o diretório raiz
  do repositório contém `server/package.json`.

## Alternativa: Raspberry Pi

O mesmo processo roda no RPi:

```bash
cd server
npm ci
PORT=3000 npm start
```

Coloque Caddy/Nginx na frente para HTTPS e encaminhe `/` e `/raknet` ao processo.
Os headers COOP/COEP já são gerados pelo próprio Node. Não é necessário mudar o
código; apenas use a URL HTTPS do RPi no navegador.
