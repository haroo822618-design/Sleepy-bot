require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ChannelType
} = require('discord.js');
const Database = require('better-sqlite3');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in environment secrets.');
  process.exit(1);
}
const FAKE_AGE_DAYS = Number(process.env.FAKE_ACCOUNT_AGE_DAYS || 7);
const db = new Database('sleepy.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS invite_stats (
  inviter_id TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  fake INTEGER NOT NULL DEFAULT 0,
  left_count INTEGER NOT NULL DEFAULT 0,
  rejoins INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invited_members (
  member_id TEXT PRIMARY KEY,
  inviter_id TEXT,
  joined_at TEXT,
  left_at TEXT,
  fake INTEGER NOT NULL DEFAULT 0,
  join_count INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
const getSetting = (key, fallback='') => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
const setSetting = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
const getStats = (id) => db.prepare('SELECT * FROM invite_stats WHERE inviter_id=?').get(id) || {inviter_id:id,total:0,fake:0,left_count:0,rejoins:0};
const addStats = (id, field, amount=1) => {
  if (!id) return;
  if (!['total','fake','left_count','rejoins'].includes(field)) return;
  db.prepare('INSERT INTO invite_stats(inviter_id) VALUES(?) ON CONFLICT(inviter_id) DO NOTHING').run(id);
  db.prepare(`UPDATE invite_stats SET ${field}=MAX(0,${field}+?) WHERE inviter_id=?`).run(amount,id);
};
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites],
  partials: [Partials.GuildMember]
});
const inviteCache = new Map();

const commands = [
  new SlashCommandBuilder().setName('invites').setDescription('View invite stats')
    .addUserOption(o=>o.setName('user').setDescription('User to check').setRequired(false)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top inviters'),
  new SlashCommandBuilder().setName('invited').setDescription('List members invited by a user')
    .addUserOption(o=>o.setName('user').setDescription('Inviter').setRequired(false)),
  new SlashCommandBuilder().setName('resetinvites').setDescription('Reset invite stats for a user (admin)')
    .addUserOption(o=>o.setName('user').setDescription('User to reset').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('skin').setDescription('Customize the invite embed (admin)')
    .addStringOption(o=>o.setName('color').setDescription('Hex color, e.g. #168BFF').setRequired(false))
    .addStringOption(o=>o.setName('title').setDescription('Embed title; use {user}').setRequired(false))
    .addStringOption(o=>o.setName('description').setDescription('Embed text; variables: {user} {total} {fake} {left} {rejoins}').setRequired(false))
    .addStringOption(o=>o.setName('image').setDescription('Direct image URL').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('welcome').setDescription('Set welcome channel (admin)')
    .addChannelOption(o=>o.setName('channel').setDescription('Channel for welcome messages').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(c=>c.toJSON());

async function registerCommands() {
  const rest = new REST({version:'10'}).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {body:commands});
  console.log('Registered guild slash commands.');
}
async function refreshInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(guild.id, new Map(invites.map(i=>[i.code,{uses:i.uses||0, inviter:i.inviter?.id||null}])));
  } catch (e) { console.warn('Could not fetch invites. Ensure Manage Server permission.',e.message); }
}
client.once('ready', async ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) await refreshInvites(guild);
  await registerCommands();
});
client.on('inviteCreate', invite=>refreshInvites(invite.guild));
client.on('inviteDelete', invite=>refreshInvites(invite.guild));

client.on('guildMemberAdd', async member=>{
  let inviterId=null, usedCode=null;
  try {
    const fresh=await member.guild.invites.fetch();
    const previous=inviteCache.get(member.guild.id)||new Map();
    for (const inv of fresh.values()) {
      const old=previous.get(inv.code);
      if (old && (inv.uses||0)>(old.uses||0)) { inviterId=inv.inviter?.id||old.inviter; usedCode=inv.code; break; }
    }
    inviteCache.set(member.guild.id,new Map(fresh.map(i=>[i.code,{uses:i.uses||0,inviter:i.inviter?.id||null}])));
  } catch(err) { console.warn('Invite attribution unavailable:',err.message); }

  const ageDays=(Date.now()-member.user.createdTimestamp)/86400000;
  const isFake=ageDays<FAKE_AGE_DAYS;
  const oldRecord=db.prepare('SELECT * FROM invited_members WHERE member_id=?').get(member.id);
  if (inviterId) {
    addStats(inviterId,'total',1);
    if (isFake) addStats(inviterId,'fake',1);
    if (oldRecord?.left_at) addStats(inviterId,'rejoins',1);
  }
  db.prepare(`INSERT INTO invited_members(member_id,inviter_id,joined_at,left_at,fake,join_count)
    VALUES(?,?,?,?,?,1) ON CONFLICT(member_id) DO UPDATE SET
    inviter_id=excluded.inviter_id, joined_at=excluded.joined_at, left_at=NULL,
    fake=excluded.fake, join_count=invited_members.join_count+1`)
    .run(member.id,inviterId,new Date().toISOString(),null,isFake?1:0);

  const welcomeChannelId=getSetting('welcome_channel');
  if (welcomeChannelId) {
    const channel=member.guild.channels.cache.get(welcomeChannelId);
    if (channel) channel.send(`💙 Welcome ${member} to **${member.guild.name}**!${inviterId?` Invited by <@${inviterId}>.`:''}`).catch(()=>{});
  }
});
client.on('guildMemberRemove', member=>{
  const rec=db.prepare('SELECT * FROM invited_members WHERE member_id=?').get(member.id);
  if (rec?.inviter_id) addStats(rec.inviter_id,'left_count',1);
  db.prepare('UPDATE invited_members SET left_at=? WHERE member_id=?').run(new Date().toISOString(),member.id);
});

function makeInviteEmbed(user,stats) {
  const color=getSetting('skin_color','#168BFF');
  const title=getSetting('skin_title',"{user}'s invites").replaceAll('{user}',user.username);
  const desc=getSetting('skin_description',
`💠  **Invite Stats**\\n\\n{user} has a total of **{total}** invites.\\n\\n🌷 Out of those, they have:\\n» {fake} fake invites\\n» {left} members left\\n» {rejoins} rejoined`)
    .replaceAll('{user}',user.username).replaceAll('{total}',stats.total)
    .replaceAll('{fake}',stats.fake).replaceAll('{left}',stats.left_count).replaceAll('{rejoins}',stats.rejoins);
  const embed=new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc)
    .setThumbnail(user.displayAvatarURL()).setFooter({text:'Sleepy Bot • Invite Tracker'});
  const image=getSetting('skin_image','');
  if (image && /^https?:\\/\\//i.test(image)) embed.setImage(image);
  return embed;
}
client.on('interactionCreate',async interaction=>{
  if (!interaction.isChatInputCommand()) return;
  const {commandName,guild}=interaction;
  if (!guild) return interaction.reply({content:'Use this command inside a server.',ephemeral:true});
  if (commandName==='invites') {
    const user=interaction.options.getUser('user')||interaction.user;
    return interaction.reply({embeds:[makeInviteEmbed(user,getStats(user.id))]});
  }
  if (commandName==='leaderboard') {
    const rows=db.prepare('SELECT inviter_id,total,fake,left_count,rejoins FROM invite_stats ORDER BY total DESC LIMIT 10').all();
    const body=rows.length?rows.map((r,i)=>`**${i+1}.** <@${r.inviter_id}> — **${r.total}** invites (fake ${r.fake}, left ${r.left_count})`).join('\\n'):'No invite data yet.';
    const embed=new EmbedBuilder().setColor(getSetting('skin_color','#168BFF')).setTitle('🏆 Sleepy Invite Leaderboard').setDescription(body);
    return interaction.reply({embeds:[embed]});
  }
  if (commandName==='invited') {
    const user=interaction.options.getUser('user')||interaction.user;
    const rows=db.prepare('SELECT member_id,left_at,fake FROM invited_members WHERE inviter_id=? ORDER BY joined_at DESC LIMIT 20').all(user.id);
    const body=rows.length?rows.map(r=>`• <@${r.member_id}> ${r.left_at?'(left)':''}${r.fake?' (possible fake)':''}`).join('\\n'):'No tracked invitees found.';
    const embed=new EmbedBuilder().setColor(getSetting('skin_color','#168BFF')).setTitle(`Invited by ${user.username}`).setDescription(body);
    return interaction.reply({embeds:[embed],ephemeral:true});
  }
  if (commandName==='resetinvites') {
    const user=interaction.options.getUser('user');
    db.prepare('DELETE FROM invite_stats WHERE inviter_id=?').run(user.id);
    db.prepare('UPDATE invited_members SET inviter_id=NULL WHERE inviter_id=?').run(user.id);
    return interaction.reply({content:`Reset invite stats for ${user}.`,ephemeral:true});
  }
  if (commandName==='skin') {
    const color=interaction.options.getString('color');
    const title=interaction.options.getString('title');
    const description=interaction.options.getString('description');
    const image=interaction.options.getString('image');
    if (color && /^#?[0-9a-fA-F]{6}$/.test(color)) setSetting('skin_color',color.startsWith('#')?color:'#'+color);
    else if(color) return interaction.reply({content:'Color must be a 6-digit hex value, e.g. #168BFF.',ephemeral:true});
    if(title) setSetting('skin_title',title);
    if(description) setSetting('skin_description',description);
    if(image) setSetting('skin_image',image);
    return interaction.reply({content:'💙 Skin saved! Variables: `{user}`, `{total}`, `{fake}`, `{left}`, `{rejoins}`. Run `/invites` to preview.',ephemeral:true});
  }
  if (commandName==='welcome') {
    setSetting('welcome_channel',interaction.options.getChannel('channel').id);
    return interaction.reply({content:'Welcome channel saved!',ephemeral:true});
  }
});
client.login(DISCORD_TOKEN);
