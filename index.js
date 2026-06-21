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

// ==================== HANDLER PRINCIPAL ====================
client.on('message', async (message) => {
  if (message.from.endsWith('@g.us')) return;

  const from = message.from;
  const text = message.body.trim();

  if (!client.userStates) client.userStates = {};
  if (!client.userStates[from]) client.userStates[from] = { step: 'menu' };
  let state = client.userStates[from];

  const lowerText = text.toLowerCase();

  if (['menu', 'oi', 'olá', 'iniciar'].includes(lowerText)) {
    await showMainMenu(message);
    client.userStates[from] = { step: 'menu' };
    return;
  }

  // Fluxo por estado
  if (state.step === 'menu') {
    if (lowerText === '1') {
      await listServices(message, from);
    } else if (lowerText === '2') {
      await showAgenda(message);
    } else if (lowerText === '3') {
      await message.reply('🔢 Envie o ID do agendamento para cancelar (em breve).');
    }
  } 
  else if (state.step === 'select_service') {
    await handleServiceSelection(message, text, from, state);
  } 
  else if (state.step === 'ask_name') {
    await handleNameInput(message, text, from, state);
  } 
  else if (state.step === 'select_date') {
    await handleDateSelection(message, text, from, state);
  } 
  else if (state.step === 'select_time') {
    await handleTimeSelection(message, text, from, state);
  }
});

async function showMainMenu(message) {
  const menu = `👋 *Bem-vinda à Manicure Agenda!*\n\n` +
    `1️⃣ Agendar horário\n` +
    `2️⃣ Ver agenda da semana\n` +
    `3️⃣ Cancelar agendamento\n\n` +
    `Digite o número da opção:`;
  await message.reply(menu);
}

async function listServices(message, from) {
  db.all("SELECT * FROM servicos", async (err, rows) => {
    if (err) {
      return await message.reply('❌ Erro ao carregar serviços.');
    }
    let text = '💅 *Nossos Serviços*\n\n';
    rows.forEach((s, i) => {
      text += `${i+1} - \( {s.nome} - R \) \( {s.preco} ( \){s.duracao} min)\n`;
    });
    text += '\nDigite o número do serviço desejado:';
    await message.reply(text);
    client.userStates[from].step = 'select_service';
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
      await message.reply('❌ Opção inválida. Tente novamente.');
    }
  });
}

async function handleNameInput(message, text, from, state) {
  state.cliente = text.trim();
  await message.reply(`Ótimo, ${state.cliente.split(' ')[0]}! 🎉\n\n` +
    `Agora informe a data:\n` +
    `• hoje\n` +
    `• amanhã\n` +
    `• Ou digite DD/MM (ex: 25/06) ou DD/MM/AAAA`);
  client.userStates[from] = { ...state, step: 'select_date' };
}

async function handleDateSelection(message, text, from, state) {
  let dateStr;
  const lower = text.toLowerCase();

  if (lower === 'hoje') {
    dateStr = dayjs().format('YYYY-MM-DD');
  } else if (lower === 'amanhã') {
    dateStr = dayjs().add(1, 'day').format('YYYY-MM-DD');
  } else {
    // Suporta DD/MM ou DD/MM/AAAA
    let day, month, year;
    if (text.includes('/')) {
      const parts = text.split('/');
      day = parts[0];
      month = parts[1];
      year = parts[2] || '2026';
      dateStr = dayjs(`\( {year}- \){month.padStart(2, '0')}-${day.padStart(2, '0')}`).format('YYYY-MM-DD');
    }
  }

  if (!dateStr || !dayjs(dateStr).isValid()) {
    return await message.reply('❌ Data inválida. Use "hoje", "amanhã" ou DD/MM.');
  }

  state.selectedDate = dateStr;
  client.userStates[from] = state;

  await showAvailableTimes(message, dateStr, from);
  client.userStates[from].step = 'select_time';
}

async function showAvailableTimes(message, date, from) {
  db.all("SELECT horario FROM agendamentos WHERE data = ? AND status = 'confirmado'", [date], async (err, booked) => {
    const bookedTimes = booked ? booked.map(b => b.horario) : [];
    let timesText = `🕒 *Horários disponíveis em ${dayjs(date).format('DD/MM/YYYY')}*\n\n`;
    let count = 0;

    for (let h = HORARIOS_INICIO; h < HORARIOS_FIM; h++) {
      const time = `${h.toString().padStart(2, '0')}:00`;
      if (!bookedTimes.includes(time)) {
        timesText += `${++count} - ${time}\n`;
      }
    }

    if (count === 0) {
      timesText += '❌ Nenhum horário disponível nesta data.';
    } else {
      timesText += '\nDigite o número do horário desejado:';
    }

    await message.reply(timesText);
  });
}

async function handleTimeSelection(message, text, from, state) {
  const timeIndex = parseInt(text) - 1;
  if (isNaN(timeIndex) || timeIndex < 0) {
    return await message.reply('❌ Opção inválida.');
  }

  const time = `${(HORARIOS_INICIO + timeIndex).toString().padStart(2, '0')}:00`;

  db.run(`INSERT INTO agendamentos (cliente, servico, data, horario, telefone) 
    VALUES (?, ?, ?, ?, ?)`, 
    [state.cliente, state.selectedService.nome, state.selectedDate, time, from],
    async function(err) {
      if (err) {
        await message.reply('❌ Erro ao salvar o agendamento.');
      } else {
        await message.reply(`🎉 *Agendamento Confirmado!*\n\n` +
          `👤 Cliente: ${state.cliente}\n` +
          `💅 Serviço: ${state.selectedService.nome}\n` +
          `📅 Data: ${dayjs(state.selectedDate).format('DD/MM/YYYY')}\n` +
          `🕒 Horário: ${time}\n\nTe esperamos! 💅`);
        client.userStates[from] = { step: 'menu' };
      }
    });
}

async function showAgenda(message) {
  db.all("SELECT * FROM agendamentos WHERE status = 'confirmado' ORDER BY data, horario LIMIT 20", async (err, rows) => {
    if (rows.length === 0) {
      return await message.reply('📅 Nenhuma agenda cadastrada.');
    }
    let text = '📋 *Agenda da Semana*\n\n';
    rows.forEach(row => {
      text += `${dayjs(row.data).format('DD/MM')} ${row.horario} - \( {row.cliente} ( \){row.servico})\n`;
    });
    await message.reply(text);
  });
}

client.initialize();
