const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const sqlite3 = require('sqlite3').verbose();
const dayjs = require('dayjs');
require('dayjs/locale/pt-br');

dayjs.locale('pt-br');

// Configurações
const HORARIOS_INICIO = 9;
const HORARIOS_FIM = 18;

// Banco de dados
const db = new sqlite3.Database('./agenda.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS agendamentos (
    id INTEGER PRIMARY KEY,
    cliente TEXT,
    servico TEXT,
    data TEXT,
    horario TEXT,
    telefone TEXT,
    status TEXT DEFAULT 'confirmado'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS servicos (
    id INTEGER PRIMARY KEY,
    nome TEXT,
    preco REAL,
    duracao INTEGER
  )`);

  db.run(`INSERT OR IGNORE INTO servicos (nome, preco, duracao) VALUES 
    ('Manicure Simples', 45.00, 60),
    ('Pedicure', 50.00, 60),
    ('Manicure + Pedicure', 85.00, 90),
    ('Alongamento de Unhas', 120.00, 120),
    ('Esmaltação em Gel', 60.00, 75)
  `);
});

console.log('🚀 Iniciando Bot de Agendamento de Manicure...');

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('📱 Escaneie o QR Code com seu WhatsApp:');
});

client.on('ready', () => {
  console.log('✅ Bot conectado e pronto!');
});

// ==================== FILTRO PRINCIPAL ====================
client.on('message', async (message) => {
  // Só responde em chats PRIVADOS (não responde em grupos)
  if (message.from.endsWith('@g.us')) {
    return; // Ignora completamente mensagens de grupos
  }

  const from = message.from;
  const text = message.body.trim().toLowerCase();

  if (!client.userStates) client.userStates = {};
  let state = client.userStates[from] || { step: 'menu' };

  // Comandos que sempre funcionam
  if (text === 'menu' || text === 'oi' || text === 'olá' || text === 'iniciar' || text === '1') {
    await showMainMenu(message);
    client.userStates[from] = { step: 'menu' };
    return;
  }

  // Fluxo do agendamento
  switch (state.step) {
    case 'menu':
      handleMenu(message, text, from, state);
      break;
    case 'select_service':
      handleServiceSelection(message, text, from, state);
      break;
    case 'ask_name':
      handleNameInput(message, text, from, state);
      break;
    case 'select_date':
      handleDateSelection(message, text, from, state);
      break;
    case 'select_time':
      handleTimeSelection(message, text, from, state);
      break;
    default:
      await showMainMenu(message);
  }
});

async function showMainMenu(message) {
  const menu = `👋 *Bem-vinda à Manicure Agenda!*\n\n` +
    `1️⃣ Agendar horário\n` +
    `2️⃣ Ver agenda da semana\n` +
    `3️⃣ Cancelar agendamento\n\n` +
    `Digite o número da opção desejada:`;
  await message.reply(menu);
}

function handleMenu(message, text, from, state) {
  if (text === '1') {
    listServices(message, from);
  } else if (text === '2') {
    showAgenda(message);
  } else if (text === '3') {
    message.reply('🔢 Envie o ID do agendamento para cancelar (em breve).');
  }
}

async function listServices(message, from) {
  db.all("SELECT * FROM servicos", async (err, rows) => {
    let text = '💅 *Nossos Serviços*\n\n';
    rows.forEach((s, i) => {
      text += `${i+1} - \( {s.nome} - R \) \( {s.preco} ( \){s.duracao} min)\n`;
    });
    text += '\nDigite o número do serviço:';
    await message.reply(text);
    client.userStates[from] = { step: 'select_service' };
  });
}

async function handleServiceSelection(message, text, from, state) {
  const serviceIndex = parseInt(text) - 1;
  db.all("SELECT * FROM servicos", async (err, rows) => {
    if (serviceIndex >= 0 && serviceIndex < rows.length) {
      state.selectedService = rows[serviceIndex];
      await message.reply(`✅ *${state.selectedService.nome}* selecionado!\n\nQual é o seu nome completo?`);
      client.userStates[from] = { ...state, step: 'ask_name' };
    } else {
      await message.reply('❌ Opção inválida.');
    }
  });
}

async function handleNameInput(message, text, from, state) {
  state.cliente = text.trim();
  await message.reply(`Ótimo, ${state.cliente.split(' ')[0]}! 🎉\n\nEscolha a data:\n• hoje\n• amanhã\n• Ou digite DD/MM (ex: 25/06)`);
  client.userStates[from] = { ...state, step: 'select_date' };
}

async function handleDateSelection(message, text, from, state) {
  let dateStr;
  const lower = text.toLowerCase();

  if (lower === 'hoje') dateStr = dayjs().format('YYYY-MM-DD');
  else if (lower === 'amanhã') dateStr = dayjs().add(1, 'day').format('YYYY-MM-DD');
  else {
    const [day, month] = text.split('/');
    if (day && month) {
      dateStr = dayjs(`2026-\( {month.padStart(2,'0')}- \){day.padStart(2,'0')}`).format('YYYY-MM-DD');
    }
  }

  if (!dateStr || !dayjs(dateStr).isValid()) {
    return message.reply('❌ Data inválida. Tente novamente.');
  }

  state.selectedDate = dateStr;
  client.userStates[from] = state;
  await showAvailableTimes(message, dateStr, state.selectedService.duracao, from);
  client.userStates[from].step = 'select_time';
}

async function showAvailableTimes(message, date, duracao, from) {
  db.all("SELECT horario FROM agendamentos WHERE data = ? AND status = 'confirmado'", [date], async (err, booked) => {
    const bookedTimes = booked.map(b => b.horario);
    let text = `🕒 *Horários disponíveis em ${dayjs(date).format('DD/MM')}*\n\n`;
    let count = 0;

    for (let h = HORARIOS_INICIO; h < HORARIOS_FIM; h++) {
      const time = `${h.toString().padStart(2, '0')}:00`;
      if (!bookedTimes.includes(time)) {
        text += `${++count} - ${time}\n`;
      }
    }

    text += count === 0 ? '❌ Nenhum horário disponível.' : '\nDigite o número do horário:';
    await message.reply(text);
  });
}

async function handleTimeSelection(message, text, from, state) {
  const timeIndex = parseInt(text) - 1;
  const time = `${(HORARIOS_INICIO + timeIndex).toString().padStart(2, '0')}:00`;

  db.run(`INSERT INTO agendamentos (cliente, servico, data, horario, telefone) VALUES (?, ?, ?, ?, ?)`,
    [state.cliente, state.selectedService.nome, state.selectedDate, time, from],
    async function(err) {
      if (err) {
        await message.reply('❌ Erro ao salvar agendamento.');
      } else {
        await message.reply(`🎉 *Agendamento Confirmado!*\n\n` +
          `👤 ${state.cliente}\n` +
          `💅 ${state.selectedService.nome}\n` +
          `📅 ${dayjs(state.selectedDate).format('DD/MM/YYYY')}\n` +
          `🕒 ${time}\n\nTe esperamos! 💅`);
        client.userStates[from] = { step: 'menu' };
      }
    });
}

client.initialize();
