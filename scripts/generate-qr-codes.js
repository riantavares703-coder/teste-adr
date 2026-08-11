#!/usr/bin/env node

/**
 * Gera QR Codes para facilitar testes mobile
 *
 * Uso:
 *   node scripts/generate-qr-codes.js
 *
 * Gera QR codes para:
 * - Link da documentação de testes
 * - Credenciais de teste
 * - Instruções rápidas
 */

const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const DOCS_URL = 'https://github.com/riantavares703-coder/teste-adr/blob/main/WINDOWS-SETUP.md';

const TEST_CREDENTIALS = {
  customer: {
    phone: '(11) 98765-4321',
  },
  operator: {
    email: 'admin@franquia-a.com',
    password: 'senha123456',
  },
};

const QUICK_LINKS = {
  'Documentação Completa': DOCS_URL,
  'App Customer': 'teste-adr://app/customer',
  'App Operator': 'teste-adr://app/operator',
};

async function generateQRCode(text, filename) {
  try {
    const filepath = path.join(__dirname, '..', 'qr-codes', filename);

    // Cria diretório se não existir
    if (!fs.existsSync(path.dirname(filepath))) {
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
    }

    await QRCode.toFile(filepath, text, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      width: 300,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });

    console.log(`✓ Gerado: ${filename}`);
    return filepath;
  } catch (err) {
    console.error(`✗ Erro ao gerar ${filename}:`, err.message);
  }
}

async function main() {
  console.log('\n📱 Gerando QR Codes para Testes...\n');

  // QR para documentação
  await generateQRCode(
    DOCS_URL,
    'qr-windows-setup.png'
  );

  // QR para credenciais do operador (como JSON)
  await generateQRCode(
    JSON.stringify(TEST_CREDENTIALS.operator),
    'qr-operator-credentials.png'
  );

  // QR codes individuais para cada link
  for (const [label, url] of Object.entries(QUICK_LINKS)) {
    const filename = `qr-${label.toLowerCase().replace(/\s+/g, '-')}.png`;
    await generateQRCode(url, filename);
  }

  console.log('\n✓ QR Codes gerados em ./qr-codes/\n');

  // Exibe instruções
  console.log('📖 Como usar:');
  console.log('  1. Abra ./qr-codes/ para ver os QR codes');
  console.log('  2. Escaneie com seu telefone');
  console.log('  3. Segue as instruções\n');

  console.log('🔐 Credenciais de teste:');
  console.log('  Operador:');
  console.log(`    Email:  ${TEST_CREDENTIALS.operator.email}`);
  console.log(`    Senha:  ${TEST_CREDENTIALS.operator.password}\n`);
}

main();
