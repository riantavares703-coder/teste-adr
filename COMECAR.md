# Começar

## Windows

1. Instale o **Node.js LTS**: https://nodejs.org
2. Duplo clique em **`INICIAR.bat`**

Na primeira vez ele prepara tudo (baixa o banco de dados, ~130 MB) e leva alguns minutos.
Depois disso, abre em segundos.

## macOS / Linux

```bash
./iniciar.sh
```

---

## O que acontece quando você abre

O programa sobe o banco de dados, o sistema e abre o **painel da loja** no navegador:

```
Painel do operador:  http://localhost:3000/admin
Cardápio do cliente: http://192.168.0.10:3000/demo/centro
```

Entre com:

```
Loja:   demo
E-mail: admin@demo.local
Senha:  restaurante123
```

---

## Como os clientes pedem

1. No painel, abra **Cardápio do cliente**
2. Imprima o **QR code** e deixe nas mesas ou no balcão
3. O cliente aponta a câmera, vê o cardápio, escolhe e envia o pedido
4. O pedido aparece na aba **Pedidos**, e você avança: Confirmado → Em preparação → Pronto

O cliente informa só **nome e telefone** — não precisa criar conta nem instalar nada.

> **Importante:** o endereço mostrado ao abrir (`http://192.168...`) só funciona para quem está no
> **mesmo Wi-Fi** da loja. Para o cliente abrir **de casa ou no 4G**, o cardápio precisa de um endereço
> público: veja [`docs/PUBLICAR.md`](docs/PUBLICAR.md). Quando tiver um, cadastre-o em **Compartilhar** —
> a tela mostra, com todas as letras, até onde o link e o QR code alcançam.
>
> Se o painel avisar que o endereço só funciona neste computador, é porque esta máquina
> não está conectada à rede da loja.
>
> Antes de divulgar um link público, **troque a senha** em *Minha conta* (clique no seu nome, no topo).

---

## Perguntas frequentes

**Preciso de internet?**
Só na primeira execução, para baixar o banco de dados. Depois funciona na rede local, sem internet — mas um link público para clientes em casa, a confirmação automática do Pix e o mapa de entrega precisam de internet.

**Onde ficam meus dados?**
Na pasta `runtime/`, dentro do programa. Faça cópia dela para não perder nada.

**Como paro o sistema?**
Feche a janela preta que ficou aberta.

**A porta 3000 já está em uso.**
Feche o outro programa que a está usando, ou defina outra porta antes de abrir:
`set PORT=3001` no Windows, `PORT=3001 ./iniciar.sh` no macOS/Linux.

---

## Para quem for desenvolver

```bash
pnpm install
pnpm test                 # 262 testes
pnpm --filter @plataforma/web-customer dev   # cardápio, porta 3001
pnpm --filter @plataforma/web-operator dev   # painel, porta 3002
```

Os dois SPAs em modo `dev` conversam com a API em `localhost:3000` por proxy.
Para servi-los pela API (como em produção), compile:

```bash
pnpm --filter @plataforma/web-customer build
pnpm --filter @plataforma/web-operator build
```

A arquitetura está em [`docs/`](docs/); os desvios, em
[`docs/ARQUITETURA-DELTA.md`](docs/ARQUITETURA-DELTA.md).
