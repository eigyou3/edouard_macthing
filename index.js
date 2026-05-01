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
  '1088369918069715024',
];

// ==============================
// 参加者データ（メッセージIDごとに管理）
// ==============================
// matchingData: messageId -> { sortMethod, participants: [{name, job, power}], authorId, authorTag, authorAvatar }
const matchingData = new Map();

// ==============================
// 戦力パース（全角・半角・M有無対応）
// ==============================
function parsePower(str) {
  // 全角数字・ピリオド・カンマを半角に
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
// チーム分けアルゴリズム
// ==============================
function makeTeams(participants, sortMethod) {
  const TEAM_SIZE = 4;
  const jobs = ['闘士', '騎士', '賢者', 'ソーサラー'];

  // 戦力でソート（降順）
  const sorted = [...participants].sort((a, b) => b.power - a.power);
  const teamCount = Math.floor(sorted.length / TEAM_SIZE);
  const remainder = sorted.length % TEAM_SIZE;
  const mainMembers = sorted.slice(0, teamCount * TEAM_SIZE);
  const remainderMembers = sorted.slice(teamCount * TEAM_SIZE);

  let teams = Array.from({ length: teamCount }, () => []);

  if (sortMethod === 'power_equal') {
    // 戦力が同じくらいの人を集める（スネーク配置＋職業被り最小化）
    // スネーク順に割り当て
    for (let i = 0; i < mainMembers.length; i++) {
      const teamIdx = Math.floor(i / TEAM_SIZE);
      teams[teamIdx].push(mainMembers[i]);
    }
    // 各チーム内で職業被り最小化のため並び替え
    teams = teams.map(team => optimizeJobBalance(team));

  } else if (sortMethod === 'total_equal') {
    // 総戦力を均等に（蛇行配置）
    for (let i = 0; i < mainMembers.length; i++) {
      const round = Math.floor(i / teamCount);
      const pos = i % teamCount;
      const teamIdx = round % 2 === 0 ? pos : teamCount - 1 - pos;
      teams[teamIdx].push(mainMembers[i]);
    }
    teams = teams.map(team => optimizeJobBalance(team));

  } else if (sortMethod === 'job_spread') {
    // 職業バラけ最優先、その後戦力均等
    teams = assignByJob(mainMembers, teamCount);
  }

  return { teams, remainderMembers };
}

function optimizeJobBalance(team) {
  // 職業被りを減らすため並び替え（簡易）
  const jobs = ['闘士', '騎士', '賢者', 'ソーサラー'];
  const used = new Set();
  const result = [];
  const rest = [];

  for (const p of team) {
    if (!used.has(p.job)) {
      used.add(p.job);
      result.push(p);
    } else {
      rest.push(p);
    }
  }
  return [...result, ...rest];
}

function assignByJob(members, teamCount) {
  const teams = Array.from({ length: teamCount }, () => []);
  const jobs = ['闘士', '騎士', '賢者', 'ソーサラー'];

  // 職業ごとにグループ
  const byJob = {};
  for (const j of jobs) byJob[j] = [];
  const unknownJob = [];

  for (const m of members) {
    if (byJob[m.job]) byJob[m.job].push(m);
    else unknownJob.push(m);
  }

  // 各職業の人を戦力順でソート
  for (const j of jobs) byJob[j].sort((a, b) => b.power - a.power);

  // 蛇行でチームに割り当て（職業ごとに）
  for (const j of jobs) {
    const group = byJob[j];
    for (let i = 0; i < group.length; i++) {
      // 最もメンバーが少ないチームに追加
      const minTeam = teams.reduce((min, t, idx) => t.length < teams[min].length ? idx : min, 0);
      teams[minTeam].push(group[i]);
    }
  }

  // 未知職業
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

// ==============================
// スラッシュコマンド登録
// ==============================
client.once('ready', async () => {
  console.log(`✅ Bot起動: ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('matching')
      .setDescription('チームマッチングを開始します'),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('✅ スラッシュコマンド登録完了');
  } catch (e) {
    console.error('スラッシュコマンド登録失敗:', e);
  }
});

// ==============================
// インタラクション処理
// ==============================
client.on('interactionCreate', async (interaction) => {

  // /matching コマンド
  if (interaction.isChatInputCommand() && interaction.commandName === 'matching') {
    const hasPermission = ALLOWED_USERS.includes(interaction.user.id);
    if (!hasPermission) {
      await interaction.reply({ content: '❌ このコマンドを使用する権限がありません。', ephemeral: true });
      return;
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('sort_power_equal')
        .setLabel('戦力が同じくらいにする')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('sort_total_equal')
        .setLabel('総戦力を揃える')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('sort_job_spread')
        .setLabel('職業をバラける')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('sort_confirm')
        .setLabel('集計する')
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({
      content: '**集計方法を選択してください**\nソート方法を選んでから「集計する」を押してください。',
      components: [row],
      ephemeral: true,
    });

    // 選択状態を保存（interactionId で管理）
    matchingData.set(`setup_${interaction.id}`, {
      sortMethod: null,
      authorId: interaction.user.id,
      authorTag: interaction.user.username,
      authorAvatar: interaction.user.displayAvatarURL({ dynamic: true }),
    });

    return;
  }

  // ソート方法選択ボタン
  if (interaction.isButton() && interaction.customId.startsWith('sort_')) {
    const hasPermission = ALLOWED_USERS.includes(interaction.user.id);
    if (!hasPermission) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true });
      return;
    }

    if (interaction.customId === 'sort_confirm') {
      // 集計する → アナウンスEmbedを投稿
      // setupデータを探す
      let setupData = null;
      for (const [key, val] of matchingData.entries()) {
        if (key.startsWith('setup_') && val.authorId === interaction.user.id) {
          setupData = val;
          matchingData.delete(key);
          break;
        }
      }

      const sortMethod = setupData?.sortMethod ?? 'total_equal';
      const sortLabel = {
        power_equal: '戦力が同じくらいにする',
        total_equal: '総戦力を揃える',
        job_spread: '職業をバラける',
      }[sortMethod] ?? '総戦力を揃える';

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setAuthor({
          name: interaction.user.username,
          iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
        })
        .setDescription(
          '**お知らせ**\n' +
          'チャンピオン大会出たいけどメンバー未定の方は\n' +
          'ギルチャかエドゥ個チャで声かけてね。\n\n' +
          `集計方法：**${sortLabel}**`
        );

      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('join_matching')
          .setLabel('参加する')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('tally_matching')
          .setLabel('集計する')
          .setStyle(ButtonStyle.Danger),
      );

      const posted = await interaction.channel.send({ embeds: [embed], components: [actionRow] });

      // 参加者データを初期化
      matchingData.set(posted.id, {
        sortMethod,
        participants: [],
        authorId: interaction.user.id,
        authorTag: interaction.user.username,
        authorAvatar: interaction.user.displayAvatarURL({ dynamic: true }),
      });

      await interaction.update({
        content: '✅ アナウンスを投稿しました！',
        components: [],
      });
      return;
    }

    // ソート方法の選択
    const methodMap = {
      sort_power_equal: 'power_equal',
      sort_total_equal: 'total_equal',
      sort_job_spread: 'job_spread',
    };
    const method = methodMap[interaction.customId];

    // setupデータを更新
    for (const [key, val] of matchingData.entries()) {
      if (key.startsWith('setup_') && val.authorId === interaction.user.id) {
        val.sortMethod = method;
        break;
      }
    }

    const labelMap = {
      power_equal: '戦力が同じくらいにする',
      total_equal: '総戦力を揃える',
      job_spread: '職業をバラける',
    };

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('sort_power_equal')
        .setLabel('戦力が同じくらいにする')
        .setStyle(method === 'power_equal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('sort_total_equal')
        .setLabel('総戦力を揃える')
        .setStyle(method === 'total_equal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('sort_job_spread')
        .setLabel('職業をバラける')
        .setStyle(method === 'job_spread' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('sort_confirm')
        .setLabel('集計する')
        .setStyle(ButtonStyle.Danger),
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

    const nameInput = new TextInputBuilder()
      .setCustomId('join_name')
      .setLabel('名前')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const jobInput = new TextInputBuilder()
      .setCustomId('join_job')
      .setLabel('職業（闘士 / 騎士 / 賢者 / ソーサラー）')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const powerInput = new TextInputBuilder()
      .setCustomId('join_power')
      .setLabel('戦力（例: 16.7M または 16.7）')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(jobInput),
      new ActionRowBuilder().addComponents(powerInput),
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
    const powerRaw = interaction.fields.getTextInputValue('join_power').trim();
    const power = parsePower(powerRaw);

    data.participants.push({ name, job, power });

    await interaction.reply({
      content: `✅ 登録完了！\n名前：${name}　職業：${job}　戦力：${formatPower(power)}\n\n現在の参加者数：**${data.participants.length}人**`,
      ephemeral: true,
    });
    return;
  }

  // 「集計する」ボタン
  if (interaction.isButton() && interaction.customId === 'tally_matching') {
    // 権限チェック
    const hasPermission = ALLOWED_USERS.includes(interaction.user.id);
    if (!hasPermission) {
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

    const http = require('http');

const { teams, remainderMembers } = makeTeams(data.participants, data.sortMethod);

    // Embed作成
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
      .setAuthor({
        name: data.authorTag,
        iconURL: data.authorAvatar,
      })
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
