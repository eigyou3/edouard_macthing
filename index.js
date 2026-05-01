const http = require('http');

const {
  Client, GatewayIntentBits, EmbedBuilder,
  REST, Routes, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder
} = require('discord.js');

// ==============================
// 権限ユーザー（追加・削除可能）
// ==============================
const ALLOWED_USERS = [
  '1088369918069715024','936419559165026304'
];

// matchingData: messageId -> { sortMethod, participants, authorId, authorTag, authorAvatar }
const matchingData = new Map();

// ==============================
// 戦力パース
// ==============================
function parsePower(str) {
  let s = str
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[．]/g, '.')
    .replace(/[，]/g, ',')
    .replace(/,/g, '')
    .replace(/[Ｍｍ]/g, 'M')
    .replace(/M/gi, '')
    .trim();
  return parseFloat(s) || 0;
}

function formatPower(val) {
  return val.toFixed(1) + 'M';
}

// ==============================
// Embedを更新する関数
// ==============================
function buildAnnounceEmbed(data, sortLabel) {
  const count = data.participants.length;
  const nameList = count > 0
    ? data.participants.map(p => p.name).join('、')
    : 'なし';

  return new EmbedBuilder()
    .setColor('#5865F2')
    .setAuthor({
      name: data.authorTag,
      iconURL: data.authorAvatar,
    })
    .setDescription(
      '**お知らせ**\n' +
      'チャンピオン大会出たいけどメンバー未定の方は\n' +
      'ギルチャかエドゥ個チャで声かけてね。\n\n' +
      `集計方法：**${sortLabel}**\n\n` +
      `現在の参加者：**${count}人**\n` +
      `参加者名：${nameList}`
    );
}

// ==============================
// チーム分けアルゴリズム
// ==============================
function makeTeams(participants, sortMethod) {
  const TEAM_SIZE = 4;
  const sorted = [...participants].sort((a, b) => b.power - a.power);
  const teamCount = Math.floor(sorted.length / TEAM_SIZE);
  const remainderMembers = sorted.slice(teamCount * TEAM_SIZE);
  const mainMembers = sorted.slice(0, teamCount * TEAM_SIZE);

  let teams = Array.from({ length: teamCount }, () => []);

  if (sortMethod === 'power_equal') {
    for (let i = 0; i < mainMembers.length; i++) {
      teams[Math.floor(i / TEAM_SIZE)].push(mainMembers[i]);
    }
    teams = teams.map(t => optimizeJobBalance(t));
  } else if (sortMethod === 'total_equal') {
    for (let i = 0; i < mainMembers.length; i++) {
      const round = Math.floor(i / teamCount);
      const pos = i % teamCount;
      const teamIdx = round % 2 === 0 ? pos : teamCount - 1 - pos;
      teams[teamIdx].push(mainMembers[i]);
    }
    teams = teams.map(t => optimizeJobBalance(t));
  } else if (sortMethod === 'job_spread') {
    teams = assignByJob(mainMembers, teamCount);
  }

  return { teams, remainderMembers };
}

function optimizeJobBalance(team) {
  const used = new Set();
  const result = [], rest = [];
  for (const p of team) {
    if (!used.has(p.job)) { used.add(p.job); result.push(p); }
    else rest.push(p);
  }
  return [...result, ...rest];
}

function assignByJob(members, teamCount) {
  const teams = Array.from({ length: teamCount }, () => []);
  const jobs = ['闘士', '騎士', '賢者', 'ソーサラー'];
  const byJob = {};
  for (const j of jobs) byJob[j] = [];
  const unknownJob = [];
  for (const m of members) {
    if (byJob[m.job]) byJob[m.job].push(m);
    else unknownJob.push(m);
  }
  for (const j of jobs) byJob[j].sort((a, b) => b.power - a.power);
  for (const j of jobs) {
    for (const member of byJob[j]) {
      const minTeam = teams.reduce((min, t, idx) => t.length < teams[min].length ? idx : min, 0);
      teams[minTeam].push(member);
    }
  }
  for (const m of unknownJob) {
    const minTeam = teams.reduce((min, t, idx) => t.length < teams[min].length ? idx : min, 0);
    teams[minTeam].push(m);
  }
  return teams;
}

// ==============================
// Discord クライアント
// ==============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('ready', async () => {
  console.log(`✅ Bot起動: ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('matching')
      .setDescription('チームマッチングを開始します'),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands.map(c => c.toJSON()) });
    console.log('✅ スラッシュコマンド登録完了');
  } catch (e) {
    console.error('スラッシュコマンド登録失敗:', e);
  }
});

// ==============================
// インタラクション処理
// ==============================
client.on('interactionCreate', async (interaction) => {

  // /matching
  if (interaction.isChatInputCommand() && interaction.commandName === 'matching') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ このコマンドを使用する権限がありません。', ephemeral: true });
      return;
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sort_power_equal').setLabel('戦力が同じくらいにする').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_total_equal').setLabel('総戦力を揃える').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_job_spread').setLabel('職業をバラける').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_confirm').setLabel('集計する').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({
      content: '**集計方法を選択してください**\nソート方法を選んでから「集計する」を押してください。',
      components: [row],
      ephemeral: true,
    });

    matchingData.set(`setup_${interaction.id}`, {
      sortMethod: null,
      authorId: interaction.user.id,
      authorTag: interaction.user.username,
      authorAvatar: interaction.user.displayAvatarURL({ dynamic: true }),
    });
    return;
  }

  // ソートボタン
  if (interaction.isButton() && interaction.customId.startsWith('sort_')) {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true });
      return;
    }

    if (interaction.customId === 'sort_confirm') {
      let setupData = null;
      for (const [key, val] of matchingData.entries()) {
        if (key.startsWith('setup_') && val.authorId === interaction.user.id) {
          setupData = val;
          matchingData.delete(key);
          break;
        }
      }

      const sortMethod = setupData?.sortMethod ?? 'total_equal';
      const sortLabel = { power_equal: '戦力が同じくらいにする', total_equal: '総戦力を揃える', job_spread: '職業をバラける' }[sortMethod] ?? '総戦力を揃える';

      const data = {
        sortMethod,
        sortLabel,
        participants: [],
        authorId: interaction.user.id,
        authorTag: interaction.user.username,
        authorAvatar: interaction.user.displayAvatarURL({ dynamic: true }),
      };

      const embed = buildAnnounceEmbed(data, sortLabel);

      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('join_matching').setLabel('参加する').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('remove_participant').setLabel('参加者を削除').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tally_matching').setLabel('集計する').setStyle(ButtonStyle.Danger),
      );

      const posted = await interaction.channel.send({ embeds: [embed], components: [actionRow] });
      matchingData.set(posted.id, data);

      await interaction.update({ content: '✅ アナウンスを投稿しました！', components: [] });
      return;
    }

    const methodMap = { sort_power_equal: 'power_equal', sort_total_equal: 'total_equal', sort_job_spread: 'job_spread' };
    const method = methodMap[interaction.customId];
    const labelMap = { power_equal: '戦力が同じくらいにする', total_equal: '総戦力を揃える', job_spread: '職業をバラける' };

    for (const [key, val] of matchingData.entries()) {
      if (key.startsWith('setup_') && val.authorId === interaction.user.id) {
        val.sortMethod = method;
        break;
      }
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sort_power_equal').setLabel('戦力が同じくらいにする').setStyle(method === 'power_equal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_total_equal').setLabel('総戦力を揃える').setStyle(method === 'total_equal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_job_spread').setLabel('職業をバラける').setStyle(method === 'job_spread' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_confirm').setLabel('集計する').setStyle(ButtonStyle.Danger),
    );

    await interaction.update({
      content: `**集計方法を選択してください**\n現在の選択：**${labelMap[method]}**\n選択が完了したら「集計する」を押してください。`,
      components: [row],
    });
    return;
  }

  // 「参加する」ボタン
  if (interaction.isButton() && interaction.customId === 'join_matching') {
    const modal = new ModalBuilder()
      .setCustomId(`join_modal:${interaction.message.id}`)
      .setTitle('参加登録');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('join_name').setLabel('名前').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('join_job').setLabel('職業（闘士 / 騎士 / 賢者 / ソーサラー）').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('join_power').setLabel('戦力（例: 16.7M または 16.7）').setStyle(TextInputStyle.Short).setRequired(true)
      ),
    );

    await interaction.showModal(modal);
    return;
  }

  // 参加モーダル送信
  if (interaction.isModalSubmit() && interaction.customId.startsWith('join_modal:')) {
    const messageId = interaction.customId.split(':')[1];
    const data = matchingData.get(messageId);

    if (!data) {
      await interaction.reply({ content: '❌ このマッチングは無効です。', ephemeral: true });
      return;
    }

    const name = interaction.fields.getTextInputValue('join_name').trim();
    const job = interaction.fields.getTextInputValue('join_job').trim();
    const power = parsePower(interaction.fields.getTextInputValue('join_power').trim());

    const validJobs = ['闘士', '騎士', '賢者', 'ソーサラー'];
    if (!validJobs.includes(job)) {
      await interaction.reply({ content: '❌ 職業は **闘士 / 騎士 / 賢者 / ソーサラー** のいずれかで入力してください。', ephemeral: true });
      return;
    }

    data.participants.push({ name, job, power });

    // Embedを更新
    const updatedEmbed = buildAnnounceEmbed(data, data.sortLabel);
    try {
      const msg = await interaction.channel.messages.fetch(messageId);
      await msg.edit({ embeds: [updatedEmbed] });
    } catch (e) {
      console.warn('Embed更新失敗:', e.message);
    }

    await interaction.reply({
      content: `✅ 登録完了！\n名前：${name}　職業：${job}　戦力：${formatPower(power)}\n現在の参加者数：**${data.participants.length}人**`,
      ephemeral: true,
    });
    return;
  }

  // 「参加者を削除」ボタン
  if (interaction.isButton() && interaction.customId === 'remove_participant') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true });
      return;
    }

    const messageId = interaction.message.id;
    const data = matchingData.get(messageId);

    if (!data || data.participants.length === 0) {
      await interaction.reply({ content: '❌ 削除できる参加者がいません。', ephemeral: true });
      return;
    }

    // 25人以上は切り捨て（Discordの制限）
    const options = data.participants.slice(0, 25).map((p, i) => ({
      label: `${p.name}（${p.job}・${formatPower(p.power)}）`,
      value: String(i),
    }));

    const select = new StringSelectMenuBuilder()
      .setCustomId(`remove_select:${messageId}`)
      .setPlaceholder('削除する参加者を選択')
      .addOptions(options);

    await interaction.reply({
      content: '削除する参加者を選択してください：',
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
    return;
  }

  // 参加者削除セレクト
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('remove_select:')) {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true });
      return;
    }

    const messageId = interaction.customId.split(':')[1];
    const data = matchingData.get(messageId);

    if (!data) {
      await interaction.reply({ content: '❌ このマッチングは無効です。', ephemeral: true });
      return;
    }

    const idx = parseInt(interaction.values[0]);
    const removed = data.participants.splice(idx, 1)[0];

    // Embedを更新
    const updatedEmbed = buildAnnounceEmbed(data, data.sortLabel);
    try {
      const msg = await interaction.channel.messages.fetch(messageId);
      await msg.edit({ embeds: [updatedEmbed] });
    } catch (e) {
      console.warn('Embed更新失敗:', e.message);
    }

    await interaction.update({
      content: `✅ **${removed.name}** を削除しました。現在の参加者数：**${data.participants.length}人**`,
      components: [],
    });
    return;
  }

  // 「集計する」ボタン
  if (interaction.isButton() && interaction.customId === 'tally_matching') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 集計する権限がありません。', ephemeral: true });
      return;
    }

    const messageId = interaction.message.id;
    const data = matchingData.get(messageId);

    if (!data) {
      await interaction.reply({ content: '❌ このマッチングは無効です。', ephemeral: true });
      return;
    }

    if (data.participants.length === 0) {
      await interaction.reply({ content: '❌ 参加者がいません。', ephemeral: true });
      return;
    }

    const { teams, remainderMembers } = makeTeams(data.participants, data.sortMethod);

    let description = '';
    teams.forEach((team, i) => {
      const members = team.map(p => `${p.name}―${p.job}―${formatPower(p.power)}`).join('┃');
      const total = team.reduce((sum, p) => sum + p.power, 0);
      description += `**チーム${i + 1}**（総戦力：${formatPower(total)}）\n${members}\n\n`;
    });

    if (remainderMembers.length > 0) {
      const members = remainderMembers.map(p => `${p.name}―${p.job}―${formatPower(p.power)}`).join('┃');
      description += `**⚠️ 余り（人数が足りません）**\n${members}`;
    }

    const resultEmbed = new EmbedBuilder()
      .setColor('#5865F2')
      .setAuthor({ name: data.authorTag, iconURL: data.authorAvatar })
      .setDescription(description);

    await interaction.reply({ embeds: [resultEmbed] });
    return;
  }
});

// ダミーHTTPサーバー（Render無料枠用）
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT, () => {
  console.log(`✅ HTTPサーバー起動: port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
