const http = require('http');
const {
  Client, GatewayIntentBits, EmbedBuilder,
  REST, Routes, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder
} = require('discord.js');

// ==============================
// 権限ユーザー
// ==============================
const ALLOWED_USERS = [
  '1088369918069715024',
];

// matchingData: messageId -> { sortMethod, sortLabel, participants, authorId, authorTag, authorAvatar }
const matchingData = new Map();

// ==============================
// 戦力パース
// ==============================
function parsePower(str) {
  return parseFloat(
    str
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[．]/g, '.').replace(/[，,]/g, '')
      .replace(/[Ｍｍ]/g, 'M').replace(/M/gi, '')
      .trim()
  ) || 0;
}
function formatPower(v) { return v.toFixed(1) + 'M'; }

// ==============================
// Embed生成
// ==============================
function buildAnnounceEmbed(data) {
  const count = data.participants.length;
  const nameList = count > 0 ? data.participants.map(p => p.name).join('、') : 'なし';
  return new EmbedBuilder()
    .setColor('#5865F2')
    .setAuthor({ name: data.authorTag, iconURL: data.authorAvatar })
    .setDescription(
      '**お知らせ**\n' +
      'チャンピオン大会出たいけどメンバー未定の方は\nギルチャかエドゥ個チャで声かけてね。\n\n' +
      `集計方法：**${data.sortLabel}**\n\n` +
      `現在の参加者：**${count}人**\n参加者名：${nameList}`
    );
}

function buildActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('join_matching').setLabel('参加する').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('remove_participant').setLabel('参加者を削除').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('edit_power').setLabel('戦力を変更').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('change_sort').setLabel('集計方法を変更').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tally_matching').setLabel('集計する').setStyle(ButtonStyle.Danger),
  );
}

const SORT_LABELS = {
  power_equal: '戦力が同じくらいにする',
  total_equal: '総戦力を揃える',
  job_spread: '職業をバラける',
};

// ==============================
// Embedを最終行に再投稿
// ==============================
async function repostEmbed(channel, oldMessageId, data) {
  // 古いメッセージを削除
  try {
    const old = await channel.messages.fetch(oldMessageId);
    await old.delete();
  } catch (e) {}

  const posted = await channel.send({
    embeds: [buildAnnounceEmbed(data)],
    components: [buildActionRow()],
  });

  // dataをIDで再登録
  matchingData.delete(oldMessageId);
  matchingData.set(posted.id, data);
  return posted;
}

// ==============================
// チーム分けアルゴリズム（改善版）
// ==============================
function makeTeams(participants, sortMethod) {
  const TEAM_SIZE = 4;
  const JOBS = ['闘士', '騎士', '賢者', 'ソーサラー'];
  const teamCount = Math.floor(participants.length / TEAM_SIZE);
  const remainderMembers = [];

  if (teamCount === 0) return { teams: [], remainderMembers: [...participants] };

  // 職業ごとにグループ化して強い順にソート
  const byJob = {};
  for (const j of JOBS) byJob[j] = [];
  const unknown = [];
  for (const p of participants) {
    if (byJob[p.job]) byJob[p.job].push({ ...p });
    else unknown.push({ ...p });
  }
  for (const j of JOBS) byJob[j].sort((a, b) => b.power - a.power);

  const teams = Array.from({ length: teamCount }, () => []);

  if (sortMethod === 'job_spread') {
    // 職業バラけ最優先：職業ごとにスネーク配置
    for (const j of JOBS) {
      const group = byJob[j];
      for (let i = 0; i < group.length; i++) {
        if (i < teamCount) {
          // スネーク配置
          const round = Math.floor(i / teamCount);
          const pos = i % teamCount;
          const teamIdx = round % 2 === 0 ? pos : teamCount - 1 - pos;
          teams[teamIdx].push(group[i]);
        } else {
          remainderMembers.push(group[i]);
        }
      }
    }
    for (const p of unknown) {
      const minTeam = teams.reduce((m, t, i) => t.length < teams[m].length ? i : m, 0);
      if (teams[minTeam].length < TEAM_SIZE) teams[minTeam].push(p);
      else remainderMembers.push(p);
    }

  } else if (sortMethod === 'power_equal') {
    // 戦力が同じくらい：全体を強い順に並べて、職業かぶりを考慮しながらスネーク配置
    const sorted = [...participants].sort((a, b) => b.power - a.power);
    const main = sorted.slice(0, teamCount * TEAM_SIZE);
    const rem = sorted.slice(teamCount * TEAM_SIZE);

    // スネーク配置
    for (let i = 0; i < main.length; i++) {
      const round = Math.floor(i / teamCount);
      const pos = i % teamCount;
      const teamIdx = round % 2 === 0 ? pos : teamCount - 1 - pos;
      teams[teamIdx].push(main[i]);
    }
    remainderMembers.push(...rem);

  } else if (sortMethod === 'total_equal') {
    // 総戦力を揃える：同じ職業同士で強さ順に入れ替えながら均等化
    // まず職業ごとにスネーク配置
    const allSorted = [...participants].sort((a, b) => b.power - a.power);
    const main = allSorted.slice(0, teamCount * TEAM_SIZE);
    const rem = allSorted.slice(teamCount * TEAM_SIZE);

    // スネーク配置（職業優先）
    for (const j of JOBS) {
      const group = byJob[j].filter(p => main.includes(p) || main.find(m => m.name === p.name));
    }

    // シンプルなスネーク配置後に総戦力均等化
    for (let i = 0; i < main.length; i++) {
      const round = Math.floor(i / teamCount);
      const pos = i % teamCount;
      const teamIdx = round % 2 === 0 ? pos : teamCount - 1 - pos;
      teams[teamIdx].push(main[i]);
    }

    // 同じ職業同士でスワップして総戦力を均等化
    let improved = true;
    let iter = 0;
    while (improved && iter < 100) {
      improved = false;
      iter++;
      for (let a = 0; a < teams.length; a++) {
        for (let b = a + 1; b < teams.length; b++) {
          for (let ai = 0; ai < teams[a].length; ai++) {
            for (let bi = 0; bi < teams[b].length; bi++) {
              if (teams[a][ai].job !== teams[b][bi].job) continue;
              const totalA = teams[a].reduce((s, p) => s + p.power, 0);
              const totalB = teams[b].reduce((s, p) => s + p.power, 0);
              const diff = Math.abs(totalA - totalB);
              // スワップ後の差
              const newA = totalA - teams[a][ai].power + teams[b][bi].power;
              const newB = totalB - teams[b][bi].power + teams[a][ai].power;
              if (Math.abs(newA - newB) < diff) {
                [teams[a][ai], teams[b][bi]] = [teams[b][bi], teams[a][ai]];
                improved = true;
              }
            }
          }
        }
      }
    }

    remainderMembers.push(...rem);
  }

  return { teams, remainderMembers };
}

// ==============================
// Discord クライアント
// ==============================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once('ready', async () => {
  console.log(`✅ Bot起動: ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: [new SlashCommandBuilder().setName('matching').setDescription('チームマッチングを開始します').toJSON()]
    });
    console.log('✅ スラッシュコマンド登録完了');
  } catch (e) { console.error(e); }
});

// ==============================
// インタラクション
// ==============================
client.on('interactionCreate', async (interaction) => {

  // /matching
  if (interaction.isChatInputCommand() && interaction.commandName === 'matching') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true }); return;
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sort_power_equal').setLabel('戦力が同じくらいにする').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_total_equal').setLabel('総戦力を揃える').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_job_spread').setLabel('職業をバラける').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_confirm').setLabel('集計する').setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({
      content: '**集計方法を選択してください**\nソート方法を選んでから「集計する」を押してください。',
      components: [row], ephemeral: true,
    });
    matchingData.set(`setup_${interaction.id}`, {
      sortMethod: null, authorId: interaction.user.id,
      authorTag: interaction.user.username,
      authorAvatar: interaction.user.displayAvatarURL({ dynamic: true }),
    });
    return;
  }

  // ソートボタン（setup時）
  if (interaction.isButton() && interaction.customId.startsWith('sort_')) {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true }); return;
    }

    if (interaction.customId === 'sort_confirm') {
      let setupData = null;
      for (const [key, val] of matchingData.entries()) {
        if (key.startsWith('setup_') && val.authorId === interaction.user.id) {
          setupData = val; matchingData.delete(key); break;
        }
      }
      const sortMethod = setupData?.sortMethod ?? 'total_equal';
      const data = {
        sortMethod, sortLabel: SORT_LABELS[sortMethod],
        participants: [],
        authorId: interaction.user.id,
        authorTag: interaction.user.username,
        authorAvatar: interaction.user.displayAvatarURL({ dynamic: true }),
      };
      const posted = await interaction.channel.send({ embeds: [buildAnnounceEmbed(data)], components: [buildActionRow()] });
      matchingData.set(posted.id, data);
      await interaction.update({ content: '✅ アナウンスを投稿しました！', components: [] });
      return;
    }

    const method = interaction.customId.replace('sort_', '');
    for (const [key, val] of matchingData.entries()) {
      if (key.startsWith('setup_') && val.authorId === interaction.user.id) { val.sortMethod = method; break; }
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sort_power_equal').setLabel('戦力が同じくらいにする').setStyle(method === 'power_equal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_total_equal').setLabel('総戦力を揃える').setStyle(method === 'total_equal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_job_spread').setLabel('職業をバラける').setStyle(method === 'job_spread' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sort_confirm').setLabel('集計する').setStyle(ButtonStyle.Danger),
    );
    await interaction.update({
      content: `**集計方法を選択してください**\n現在の選択：**${SORT_LABELS[method]}**\n選択が完了したら「集計する」を押してください。`,
      components: [row],
    });
    return;
  }

  // 「参加する」ボタン
  if (interaction.isButton() && interaction.customId === 'join_matching') {
    const modal = new ModalBuilder().setCustomId(`join_modal:${interaction.message.id}`).setTitle('参加登録');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('join_name').setLabel('名前').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('join_job').setLabel('職業（闘士 / 騎士 / 賢者 / ソーサラー）').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('join_power').setLabel('戦力（例: 16.7M または 16.7）').setStyle(TextInputStyle.Short).setRequired(true)),
    );
    await interaction.showModal(modal);
    return;
  }

  // 参加モーダル送信
  if (interaction.isModalSubmit() && interaction.customId.startsWith('join_modal:')) {
    const messageId = interaction.customId.split(':')[1];
    const data = matchingData.get(messageId);
    if (!data) { await interaction.reply({ content: '❌ 無効です。', ephemeral: true }); return; }

    const name = interaction.fields.getTextInputValue('join_name').trim();
    const job = interaction.fields.getTextInputValue('join_job').trim();
    const power = parsePower(interaction.fields.getTextInputValue('join_power').trim());

    if (!['闘士', '騎士', '賢者', 'ソーサラー'].includes(job)) {
      await interaction.reply({ content: '❌ 職業は **闘士 / 騎士 / 賢者 / ソーサラー** のいずれかで入力してください。', ephemeral: true });
      return;
    }

    data.participants.push({ name, job, power });
    await interaction.deferReply({ ephemeral: true });
    const posted = await repostEmbed(interaction.channel, messageId, data);
    await interaction.editReply({ content: `✅ 登録完了！${name}（${job}・${formatPower(power)}）\n現在：**${data.participants.length}人**` });
    return;
  }

  // 「参加者を削除」ボタン
  if (interaction.isButton() && interaction.customId === 'remove_participant') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true }); return;
    }
    const data = matchingData.get(interaction.message.id);
    if (!data || data.participants.length === 0) {
      await interaction.reply({ content: '❌ 削除できる参加者がいません。', ephemeral: true }); return;
    }
    const options = data.participants.slice(0, 25).map((p, i) => ({
      label: `${p.name}（${p.job}・${formatPower(p.power)}）`, value: `${i}`,
    }));
    await interaction.reply({
      content: '削除する参加者を選択（続けて選択できます）：',
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`remove_select:${interaction.message.id}`).setPlaceholder('参加者を選択').addOptions(options)
      )],
      ephemeral: true,
    });
    return;
  }

  // 参加者削除セレクト
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('remove_select:')) {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true }); return;
    }
    const messageId = interaction.customId.split(':')[1];
    const data = matchingData.get(messageId);
    if (!data) { await interaction.update({ content: '❌ 無効です。', components: [] }); return; }

    const idx = parseInt(interaction.values[0]);
    const removed = data.participants.splice(idx, 1)[0];

    // 再投稿
    await interaction.deferUpdate();
    const posted = await repostEmbed(interaction.channel, messageId, data);

    // セレクトメニューを更新（まだ参加者がいれば続けて選択可能）
    if (data.participants.length > 0) {
      const options = data.participants.slice(0, 25).map((p, i) => ({
        label: `${p.name}（${p.job}・${formatPower(p.power)}）`, value: `${i}`,
      }));
      await interaction.editReply({
        content: `✅ **${removed.name}** を削除しました。続けて選択できます（現在：${data.participants.length}人）`,
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId(`remove_select:${posted.id}`).setPlaceholder('参加者を選択').addOptions(options)
        )],
      });
    } else {
      await interaction.editReply({ content: `✅ **${removed.name}** を削除しました。参加者が0人になりました。`, components: [] });
    }
    return;
  }

  // 「戦力を変更」ボタン
  if (interaction.isButton() && interaction.customId === 'edit_power') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true }); return;
    }
    const data = matchingData.get(interaction.message.id);
    if (!data || data.participants.length === 0) {
      await interaction.reply({ content: '❌ 参加者がいません。', ephemeral: true }); return;
    }
    const options = data.participants.slice(0, 25).map((p, i) => ({
      label: `${p.name}（${p.job}・${formatPower(p.power)}）`, value: `${i}`,
    }));
    await interaction.reply({
      content: '戦力を変更する参加者を選択：',
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`edit_select:${interaction.message.id}`).setPlaceholder('参加者を選択').addOptions(options)
      )],
      ephemeral: true,
    });
    return;
  }

  // 戦力変更セレクト → モーダル
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('edit_select:')) {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true }); return;
    }
    const messageId = interaction.customId.split(':')[1];
    const idx = parseInt(interaction.values[0]);
    const data = matchingData.get(messageId);
    if (!data) { await interaction.update({ content: '❌ 無効です。', components: [] }); return; }

    const p = data.participants[idx];
    const modal = new ModalBuilder()
      .setCustomId(`edit_power_modal:${messageId}:${idx}`)
      .setTitle(`${p.name} の戦力を変更`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('new_power').setLabel(`現在：${formatPower(p.power)}　新しい戦力を入力`).setStyle(TextInputStyle.Short).setRequired(true)
      )
    );
    await interaction.showModal(modal);
    return;
  }

  // 戦力変更モーダル送信
  if (interaction.isModalSubmit() && interaction.customId.startsWith('edit_power_modal:')) {
    const [, messageId, idxStr] = interaction.customId.split(':');
    const idx = parseInt(idxStr);
    const data = matchingData.get(messageId);
    if (!data) { await interaction.reply({ content: '❌ 無効です。', ephemeral: true }); return; }

    const newPower = parsePower(interaction.fields.getTextInputValue('new_power').trim());
    const p = data.participants[idx];
    const oldPower = p.power;
    p.power = newPower;

    await interaction.deferReply({ ephemeral: true });
    const posted = await repostEmbed(interaction.channel, messageId, data);

    // 続けて変更できるようにセレクトを再表示
    const options = data.participants.slice(0, 25).map((p2, i) => ({
      label: `${p2.name}（${p2.job}・${formatPower(p2.power)}）`, value: `${i}`,
    }));
    await interaction.editReply({
      content: `✅ **${p.name}** の戦力を ${formatPower(oldPower)} → ${formatPower(newPower)} に変更しました。\n続けて変更できます：`,
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`edit_select:${posted.id}`).setPlaceholder('参加者を選択').addOptions(options)
      )],
    });
    return;
  }

  // 「集計方法を変更」ボタン
  if (interaction.isButton() && interaction.customId === 'change_sort') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true }); return;
    }
    const data = matchingData.get(interaction.message.id);
    if (!data) { await interaction.reply({ content: '❌ 無効です。', ephemeral: true }); return; }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`chs_power_equal:${interaction.message.id}`).setLabel('戦力が同じくらいにする').setStyle(data.sortMethod === 'power_equal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`chs_total_equal:${interaction.message.id}`).setLabel('総戦力を揃える').setStyle(data.sortMethod === 'total_equal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`chs_job_spread:${interaction.message.id}`).setLabel('職業をバラける').setStyle(data.sortMethod === 'job_spread' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
    await interaction.reply({
      content: `現在の集計方法：**${data.sortLabel}**\n変更先を選んでください：`,
      components: [row], ephemeral: true,
    });
    return;
  }

  // 集計方法変更ボタン
  if (interaction.isButton() && interaction.customId.startsWith('chs_')) {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true }); return;
    }
    const parts = interaction.customId.split(':');
    const method = parts[0].replace('chs_', '');
    const messageId = parts[1];
    const data = matchingData.get(messageId);
    if (!data) { await interaction.update({ content: '❌ 無効です。', components: [] }); return; }

    data.sortMethod = method;
    data.sortLabel = SORT_LABELS[method];

    await interaction.deferUpdate();
    const posted = await repostEmbed(interaction.channel, messageId, data);
    await interaction.editReply({ content: `✅ 集計方法を **${SORT_LABELS[method]}** に変更しました！`, components: [] });
    return;
  }

  // 「集計する」ボタン
  if (interaction.isButton() && interaction.customId === 'tally_matching') {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ 権限がありません。', ephemeral: true }); return;
    }
    const data = matchingData.get(interaction.message.id);
    if (!data) { await interaction.reply({ content: '❌ 無効です。', ephemeral: true }); return; }
    if (data.participants.length === 0) { await interaction.reply({ content: '❌ 参加者がいません。', ephemeral: true }); return; }

    const { teams, remainderMembers } = makeTeams(data.participants, data.sortMethod);

    let description = '';
    teams.forEach((team, i) => {
      const members = team.map(p => `${p.name}―${p.job}―${formatPower(p.power)}`).join('┃');
      const total = team.reduce((s, p) => s + p.power, 0);
      description += `**チーム${i + 1}**（総戦力：${formatPower(total)}）\n${members}\n\n`;
    });
    if (remainderMembers.length > 0) {
      description += `**⚠️ 余り（人数が足りません）**\n${remainderMembers.map(p => `${p.name}―${p.job}―${formatPower(p.power)}`).join('┃')}`;
    }

    await interaction.reply({
      embeds: [new EmbedBuilder().setColor('#5865F2').setAuthor({ name: data.authorTag, iconURL: data.authorAvatar }).setDescription(description)]
    });
    return;
  }
});

// ダミーHTTPサーバー
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(PORT, () => {
  console.log(`✅ HTTPサーバー起動: port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
