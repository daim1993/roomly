'use strict';

/**
 * Roomly client application.
 * State lives here; js/ modules provide the socket, WebRTC engine, rendering
 * helpers and emoji data. Everything renders from state — the server's
 * `ready` snapshot (sent on every [re]connect) is the source of truth.
 */

import { el, icon, initials, avatarEl, formatTime, formatDay, formatFull, formatBytes, sameDay, toast, copyText, beep, debounce } from '/js/util.js';
import { EMOJI_GROUPS, QUICK_REACTIONS } from '/js/emoji.js';
import { renderContent, contentPreview } from '/js/markdown.js';
import { RoomlySocket } from '/js/socket.js';
import { VoiceManager } from '/js/rtc.js';
import * as fx from '/js/fx.js';

const $ = (selector) => document.querySelector(selector);

const ui = {
  authView: $('#authView'),
  appView: $('#appView'),
  authInviteNote: $('#authInviteNote'),
  railServers: $('#railServers'),
  homeButton: $('#homeButton'),
  addServerButton: $('#addServerButton'),
  sidebarTitle: $('#sidebarTitle'),
  serverMenuButton: $('#serverMenuButton'),
  dmPane: $('#dmPane'),
  dmList: $('#dmList'),
  dmEmpty: $('#dmEmpty'),
  findUserButton: $('#findUserButton'),
  channelPane: $('#channelPane'),
  textChannelList: $('#textChannelList'),
  voiceChannelList: $('#voiceChannelList'),
  addTextChannelButton: $('#addTextChannelButton'),
  addVoiceChannelButton: $('#addVoiceChannelButton'),
  voiceDock: $('#voiceDock'),
  voiceDockStatus: $('#voiceDockStatus'),
  voiceDockName: $('#voiceDockName'),
  voiceDockLeave: $('#voiceDockLeave'),
  dockMicButton: $('#dockMicButton'),
  dockCamButton: $('#dockCamButton'),
  dockScreenButton: $('#dockScreenButton'),
  meAvatar: $('#meAvatar'),
  meName: $('#meName'),
  meTag: $('#meTag'),
  settingsButton: $('#settingsButton'),
  appViewEl: $('#appView'),
  backButton: $('#backButton'),
  mobileNav: $('#mobileNav'),
  mnavHome: $('#mnavHome'),
  mnavChats: $('#mnavChats'),
  mnavMe: $('#mnavMe'),
  mnavBadge: $('#mnavBadge'),
  channelIcon: $('#channelIcon'),
  channelTitle: $('#channelTitle'),
  channelTopic: $('#channelTopic'),
  voiceChatButton: $('#voiceChatButton'),
  invitePeopleButton: $('#invitePeopleButton'),
  toggleMembersButton: $('#toggleMembersButton'),
  chatView: $('#chatView'),
  messageScroll: $('#messageScroll'),
  messageList: $('#messageList'),
  chatIntro: $('#chatIntro'),
  loadOlderButton: $('#loadOlderButton'),
  typingBar: $('#typingBar'),
  replyBar: $('#replyBar'),
  replyBarName: $('#replyBarName'),
  replyBarCancel: $('#replyBarCancel'),
  attachPreview: $('#attachPreview'),
  composerInput: $('#composerInput'),
  attachButton: $('#attachButton'),
  emojiButton: $('#emojiButton'),
  sendButton: $('#sendButton'),
  fileInput: $('#fileInput'),
  voiceMsgButton: $('#voiceMsgButton'),
  recBar: $('#recBar'),
  recTime: $('#recTime'),
  recCancel: $('#recCancel'),
  recSend: $('#recSend'),
  contentStack: document.querySelector('.content-stack'),
  voiceView: $('#voiceView'),
  voicePrejoin: $('#voicePrejoin'),
  voicePrejoinTitle: $('#voicePrejoinTitle'),
  voicePrejoinCount: $('#voicePrejoinCount'),
  voicePrejoinFaces: $('#voicePrejoinFaces'),
  voiceJoinButton: $('#voiceJoinButton'),
  voiceJoinMicButton: $('#voiceJoinMicButton'),
  voiceStage: $('#voiceStage'),
  callTimer: $('#callTimer'),
  voiceGrid: $('#voiceGrid'),
  screenStage: $('#screenStage'),
  screenVideo: $('#screenVideo'),
  screenLabel: $('#screenLabel'),
  screenSelfNote: $('#screenSelfNote'),
  screenSelfStop: $('#screenSelfStop'),
  stageAvatar: $('#stageAvatar'),
  unpinButton: $('#unpinButton'),
  sharePill: $('#sharePill'),
  vMicButton: $('#vMicButton'),
  vCamButton: $('#vCamButton'),
  vScreenButton: $('#vScreenButton'),
  vLeaveButton: $('#vLeaveButton'),
  homeView: $('#homeView'),
  homeGreeting: $('#homeGreeting'),
  homeSub: $('#homeSub'),
  homeServerCards: $('#homeServerCards'),
  homeCreateServer: $('#homeCreateServer'),
  homeJoinServer: $('#homeJoinServer'),
  memberPanel: $('#memberPanel'),
  memberList: $('#memberList'),
  modalRoot: $('#modalRoot'),
  modalCard: $('#modalCard'),
  popover: $('#popover'),
  emojiPopup: $('#emojiPopup'),
  mentionPopup: $('#mentionPopup'),
  connBanner: $('#connBanner'),
  lightbox: $('#lightbox')
};

const state = {
  me: null,
  connId: null,
  servers: new Map(),
  dms: new Map(),
  users: new Map(),
  online: new Set(),
  lastRead: {},
  mentions: {},
  voiceStates: new Map(), // channelKey -> participants[]
  voiceLimit: 12,
  messages: new Map(), // channelKey -> {list, hasMore, loaded}
  typing: new Map(), // channelKey -> Map<userId, expiresAt>
  view: { kind: 'home' },
  mobilePane: 'home', // 'home' | 'nav' | 'content' — phone-size stack navigation
  voiceChatOpen: false,
  memberPanelOpen: true,
  replyTo: null,
  editingId: null,
  pendingAttachments: [],
  mentionTokens: new Map(), // display name -> userId (composer session)
  focusedScreen: null,
  pinned: null, // 'self' | connId — Meet-style participant pin
  pendingInvite: null,
  booted: false
};

const socket = new RoomlySocket();
const voice = new VoiceManager({
  socket,
  onUpdate: () => {
    renderVoiceView();
    renderVoiceDock();
    renderSidebar();
    syncVoiceAudio();
  },
  onSpeaking: (key, speaking) => {
    const connId = key === 'self' ? state.connId : key;
    const tile = voiceTileEls.get(key === 'self' ? 'self' : key);
    if (tile) {
      tile.classList.toggle('is-speaking', speaking);
    }
    for (const row of document.querySelectorAll(`[data-occ-conn="${connId}"]`)) {
      row.classList.toggle('is-speaking', speaking);
    }
  },
  onEnded: () => {
    state.focusedScreen = null;
    state.pinned = null;
    renderVoiceView();
    renderVoiceDock();
    renderSidebar();
    syncVoiceAudio();
  }
});

const msgEls = new Map(); // messageId -> <li>
const voiceTileEls = new Map(); // connId|'self' -> tile
const voiceAudioEls = new Map(); // connId -> <audio>

// ============================================================== helpers

function keyForText(serverId, channelId) {
  return `srv:${serverId}:${channelId}`;
}

function keyForDm(dmId) {
  return `dm:${dmId}`;
}

function activeChannelKey() {
  const view = state.view;
  if (view.kind === 'text' || view.kind === 'voice') {
    return keyForText(view.serverId, view.channelId);
  }
  if (view.kind === 'dm') {
    return keyForDm(view.dmId);
  }
  return null;
}

function getUser(userId) {
  return state.users.get(userId) || { id: userId, name: 'Unknown', color: 8, guest: false };
}

function getServer(serverId) {
  return state.servers.get(serverId) || null;
}

function getChannel(serverId, channelId) {
  const server = getServer(serverId);
  return server ? server.channels.find((channel) => channel.id === channelId) || null : null;
}

function myRole(server) {
  return server ? server.myRole : null;
}

function isModerator(server) {
  return server && (server.myRole === 'owner' || server.myRole === 'admin');
}

function canModerate(server, targetId) {
  if (!server || targetId === state.me.id) {
    return false;
  }
  const rank = { member: 0, admin: 1, owner: 2 };
  const target = server.members.find((member) => member.userId === targetId);
  const mine = rank[server.myRole] ?? -1;
  const theirs = target ? rank[target.role] : 0;
  return mine >= 1 && mine > theirs;
}

function isUnread(channelKey, lastAt) {
  return (lastAt || 0) > (state.lastRead[channelKey] || 0);
}

function serverMentionCount(server) {
  let total = 0;
  for (const channel of server.channels) {
    if (channel.type === 'text') {
      total += state.mentions[keyForText(server.id, channel.id)] || 0;
    }
  }
  return total;
}

function serverHasUnread(server) {
  return server.channels.some(
    (channel) => channel.type === 'text' && isUnread(keyForText(server.id, channel.id), channel.lastAt)
  );
}

const mobileQuery = window.matchMedia('(max-width: 820px)');

function isMobile() {
  return mobileQuery.matches;
}

function applyMobileLayout() {
  const mobile = isMobile();
  ui.appViewEl.classList.toggle('is-mobile', mobile);
  ui.appViewEl.classList.toggle('m-home', mobile && state.mobilePane === 'home');
  ui.appViewEl.classList.toggle('m-nav', mobile && state.mobilePane === 'nav');
  ui.appViewEl.classList.toggle('m-content', mobile && state.mobilePane === 'content');
  ui.backButton.hidden = !(mobile && state.mobilePane === 'content');
  ui.appViewEl.classList.toggle('has-dock', mobile && voice.active);

  // The voice dock must survive whichever pane is hidden: on phones it lives
  // on <body> pinned above the nav bar; on desktop it sits in the sidebar.
  const userBar = document.querySelector('.user-bar');
  if (mobile && ui.voiceDock.parentElement !== document.body) {
    document.body.append(ui.voiceDock);
  } else if (!mobile && ui.voiceDock.parentElement === document.body && userBar) {
    userBar.parentElement.insertBefore(ui.voiceDock, userBar);
  }

  ui.mnavHome.classList.toggle('is-active', state.mobilePane === 'home');
  ui.mnavChats.classList.toggle('is-active', state.mobilePane !== 'home');
  let mentionTotal = 0;
  for (const count of Object.values(state.mentions)) {
    mentionTotal += count;
  }
  ui.mnavBadge.hidden = !mentionTotal;
  ui.mnavBadge.textContent = mentionTotal > 99 ? '99+' : String(mentionTotal);
}

const CARD_COLORS = 6;

function colorClassAt(index) {
  return `card-c${index % CARD_COLORS}`;
}

function formatRemaining(expiresAt) {
  const ms = Math.max(0, expiresAt - Date.now());
  let hours = Math.floor(ms / 3_600_000);
  let minutes = Math.round((ms % 3_600_000) / 60_000);
  if (minutes === 60) {
    hours += 1;
    minutes = 0;
  }
  if (hours >= 1) {
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.max(1, minutes)} min`;
}

setInterval(() => {
  const server = (state.view.kind === 'text' || state.view.kind === 'voice') ? getServer(state.view.serverId) : null;
  if (server && server.temp) {
    renderSidebar();
  }
}, 30_000);

function updateTitle() {
  let mentionTotal = 0;
  for (const count of Object.values(state.mentions)) {
    mentionTotal += count;
  }
  document.title = mentionTotal ? `(${mentionTotal}) Roomly` : 'Roomly';
  applyMobileLayout();
}

// ============================================================== rendering

function renderAll() {
  renderRail();
  renderSidebar();
  renderMeBar();
  renderVoiceDock();
  renderMainView();
  updateTitle();
  applyMobileLayout();
}

function renderRail() {
  ui.homeButton.classList.toggle('is-active', state.view.kind === 'home' || state.view.kind === 'dm');
  let dmMentions = 0;
  for (const dm of state.dms.values()) {
    dmMentions += state.mentions[keyForDm(dm.id)] || 0;
    // any unread dm shows as badge-less bold handled in list; rail badge counts mentions only
  }
  let dmUnread = 0;
  for (const dm of state.dms.values()) {
    if (isUnread(keyForDm(dm.id), dm.lastAt)) {
      dmUnread += 1;
    }
  }
  const homeBadge = ui.homeButton.querySelector('.rail-badge');
  const homeCount = dmMentions || dmUnread;
  homeBadge.hidden = !homeCount;
  homeBadge.textContent = homeCount > 99 ? '99+' : String(homeCount);
  ui.homeButton.classList.toggle('has-unread', dmUnread > 0);

  ui.railServers.replaceChildren();
  const servers = Array.from(state.servers.values()).sort((a, b) => a.createdAt - b.createdAt);
  for (const server of servers) {
    const mentions = serverMentionCount(server);
    const button = el('button', {
      class: 'rail-item',
      type: 'button',
      title: server.temp ? `${server.name} · temporary` : server.name,
      dataset: { serverId: server.id },
      onclick: () => openServer(server.id)
    }, server.icon || initials(server.name));
    button.classList.toggle('is-active',
      (state.view.kind === 'text' || state.view.kind === 'voice') && state.view.serverId === server.id);
    button.classList.toggle('has-unread', serverHasUnread(server));
    if (mentions) {
      button.append(el('span', { class: 'rail-badge', text: mentions > 99 ? '99+' : String(mentions) }));
    }
    ui.railServers.append(button);
  }
}

function paintAvatar(node, user) {
  node.className = `avatar c${user.color || 1}`;
  node.replaceChildren();
  if (user.avatar) {
    node.classList.add('has-img');
    node.append(el('img', { src: user.avatar, alt: '' }));
  } else {
    node.textContent = initials(user.name);
  }
}

function renderMeBar() {
  const me = state.me;
  paintAvatar(ui.meAvatar, me);
  ui.meName.textContent = me.name;
  ui.meTag.textContent = me.guest ? 'Guest' : `@${me.username}`;
  const hpAvatar = document.getElementById('hpAvatar');
  if (hpAvatar) {
    paintAvatar(hpAvatar, me);
    document.getElementById('hpName').textContent = me.name;
    document.getElementById('hpRole').textContent =
      me.guest ? 'Guest' : (me.platformAdmin ? 'Platform admin' : 'Online');
  }
}

function renderSidebar() {
  const inServer = state.view.kind === 'text' || state.view.kind === 'voice';
  const server = inServer ? getServer(state.view.serverId) : null;

  ui.dmPane.hidden = Boolean(server);
  ui.channelPane.hidden = !server;
  ui.serverMenuButton.hidden = !server;
  ui.sidebarTitle.textContent = server ? server.name : 'Direct messages';

  if (!server) {
    renderDmList();
    return;
  }

  const moderator = isModerator(server);
  ui.addTextChannelButton.hidden = !moderator;
  ui.addVoiceChannelButton.hidden = !moderator;

  const oldBanner = ui.channelPane.querySelector('.temp-banner');
  if (oldBanner) {
    oldBanner.remove();
  }
  if (server.temp && server.expiresAt) {
    ui.channelPane.prepend(el('div', { class: 'temp-banner', title: 'Guest-hosted servers close automatically.' },
      icon('i-refresh'),
      el('span', {},
        el('strong', { text: 'Temporary server' }),
        el('small', { text: `Closes in ${formatRemaining(server.expiresAt)}` })
      )
    ));
  }

  ui.textChannelList.replaceChildren();
  ui.voiceChannelList.replaceChildren();

  let cardIndex = 0;
  for (const channel of server.channels) {
    if (channel.type === 'text') {
      ui.textChannelList.append(renderTextChannelItem(server, channel, cardIndex));
    } else {
      ui.voiceChannelList.append(renderVoiceChannelItem(server, channel, cardIndex));
    }
    cardIndex += 1;
  }
}

function renderTextChannelItem(server, channel, cardIndex = 0) {
  const channelKey = keyForText(server.id, channel.id);
  const active = state.view.kind === 'text' && state.view.channelId === channel.id;
  const mentions = state.mentions[channelKey] || 0;
  const unread = isUnread(channelKey, channel.lastAt);
  const item = el('button', {
    class: `channel-item ${colorClassAt(cardIndex)}`,
    type: 'button',
    onclick: () => openTextChannel(server.id, channel.id)
  },
    el('span', { class: 'ch-icon' }, icon('i-hash')),
    el('span', { class: 'channel-name', text: channel.name }),
    el('span', { class: 'ch-pills' },
      mentions ? el('span', { class: 'pill-chip mention-badge', text: `${mentions > 99 ? '99+' : mentions} ping${mentions === 1 ? '' : 's'}` }) : null,
      !mentions && unread && !active ? el('span', { class: 'pill-chip', text: 'new' }) : null,
      !mentions && unread && !active ? el('span', { class: 'unread-dot', hidden: true }) : null
    )
  );
  item.classList.toggle('is-active', active);
  item.classList.toggle('has-unread', unread);
  if (isModerator(server)) {
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openChannelSettings(server, channel);
    });
  }
  return item;
}

function renderVoiceChannelItem(server, channel, cardIndex = 0) {
  const channelKey = keyForText(server.id, channel.id);
  const participants = state.voiceStates.get(channelKey) || [];
  const active = state.view.kind === 'voice' && state.view.channelId === channel.id;

  const item = el('button', {
    class: `channel-item is-voice ${colorClassAt(cardIndex)}`,
    type: 'button',
    onclick: () => openVoiceChannel(server.id, channel.id)
  },
    el('span', { class: 'ch-icon' }, icon('i-speaker')),
    el('span', { class: 'channel-name', text: channel.name }),
    el('span', { class: 'ch-pills' },
      participants.length ? el('span', { class: 'pill-chip live channel-live', text: `● ${participants.length} live` }) : null,
      (state.mentions[channelKey] || 0) ? el('span', { class: 'pill-chip mention-badge', text: `${state.mentions[channelKey]} ping${state.mentions[channelKey] === 1 ? '' : 's'}` }) : null,
      !(state.mentions[channelKey] || 0) && isUnread(channelKey, channel.lastAt) && !active ? el('span', { class: 'pill-chip', text: 'new' }) : null
    )
  );
  item.classList.toggle('is-active', active);
  if (isModerator(server)) {
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openChannelSettings(server, channel);
    });
  }

  const wrap = el('div', {});
  wrap.append(item);
  if (participants.length) {
    const list = el('div', { class: 'voice-occupants' });
    for (const participant of participants) {
      const user = getUser(participant.userId);
      const row = el('div', { class: 'voice-occupant', dataset: { occConn: participant.connId } },
        avatarEl(user),
        el('span', { class: 'occ-name', text: user.name }),
        participant.media && participant.media.screen ? icon('i-screen', 'occ-screen') : null,
        participant.media && !participant.media.audio ? icon('i-mic-off') : null,
        participant.media && participant.media.video ? icon('i-cam') : null
      );
      list.append(row);
    }
    wrap.append(list);
  }
  return wrap;
}

function renderDmList() {
  ui.dmList.replaceChildren();
  const dms = Array.from(state.dms.values()).sort((a, b) => (b.lastAt || b.createdAt) - (a.lastAt || a.createdAt));
  ui.dmEmpty.hidden = dms.length > 0;
  for (const dm of dms) {
    const user = getUser(dm.otherUserId);
    const channelKey = keyForDm(dm.id);
    const mentions = state.mentions[channelKey] || 0;
    const item = el('button', {
      class: 'dm-item',
      type: 'button',
      onclick: () => openDm(dm.id)
    },
      avatarEl(user),
      el('span', { class: 'dm-name', text: user.name }),
      mentions ? el('span', { class: 'mention-badge', text: String(mentions) }) : null,
      el('span', { class: `presence-dot${state.online.has(user.id) ? ' online' : ''}` })
    );
    item.classList.toggle('is-active', state.view.kind === 'dm' && state.view.dmId === dm.id);
    item.classList.toggle('has-unread', isUnread(channelKey, dm.lastAt));
    ui.dmList.append(item);
  }
}

function renderVoiceDock() {
  const connected = voice.active && voice.channelKey;
  ui.voiceDock.hidden = !connected;
  ui.sharePill.hidden = !(connected && voice.screenStream);
  applyMobileLayout();
  syncCallKeepAlive();
  if (!connected) {
    return;
  }
  const [, serverId, channelId] = voice.channelKey.split(':');
  const server = getServer(serverId);
  const channel = getChannel(serverId, channelId);
  ui.voiceDockName.textContent = server && channel ? `${channel.name} — ${server.name}` : 'Voice channel';
  ui.voiceDockName.onclick = () => {
    if (server && channel) {
      openVoiceChannel(serverId, channelId);
    }
  };

  // Keep the always-visible controls in sync with the live media state.
  const media = voice.media();
  ui.dockMicButton.classList.toggle('is-off', !media.audio);
  ui.dockMicButton.setAttribute('aria-pressed', String(media.audio));
  ui.dockCamButton.classList.toggle('is-off', !media.video);
  ui.dockCamButton.setAttribute('aria-pressed', String(media.video));
  ui.dockScreenButton.classList.toggle('is-live', media.screen);
  ui.dockScreenButton.setAttribute('aria-pressed', String(media.screen));
  ui.dockScreenButton.title = media.screen ? 'Stop sharing your screen' : 'Share your screen';
  ui.voiceDockStatus.classList.toggle('is-sharing', media.screen);
  ui.voiceDockStatus.querySelector('span').textContent = media.screen ? 'Sharing your screen' : 'Voice connected';
}

let lastViewSignature = '';

function renderHome() {
  const hour = new Date().getHours();
  const daypart = hour < 5 ? 'tonight' : hour < 12 ? 'this morning' : hour < 18 ? 'today' : 'tonight';
  const first = (state.me.name || '').split(/\s+/)[0];
  ui.homeGreeting.textContent = `How's it going ${daypart}, ${first}?`;

  const servers = Array.from(state.servers.values()).sort((a, b) => a.createdAt - b.createdAt);
  ui.homeSub.textContent = servers.length
    ? 'Jump back into your spaces, or start something new.'
    : 'Create a server for your crew, or join one with an invite link.';

  const statsEl = document.getElementById('homeStats');
  if (statsEl) {
    let inVoice = 0;
    for (const list of state.voiceStates.values()) {
      inVoice += (list || []).length;
    }
    statsEl.hidden = false;
    statsEl.replaceChildren(
      el('span', { class: 'stat-cell' },
        el('b', { text: String(servers.length) }),
        el('small', { text: servers.length === 1 ? 'Server' : 'Servers' })),
      el('span', { class: 'stat-cell' },
        el('b', { text: String(state.online.size) }),
        el('small', { text: 'Online now' })),
      el('span', { class: 'stat-cell' },
        el('b', { text: String(inVoice) }),
        el('small', { text: 'In voice' }))
    );
  }

  ui.homeServerCards.replaceChildren();
  let cardIndex = 0;
  for (const server of servers) {
    const liveCount = server.channels
      .filter((channel) => channel.type === 'voice')
      .reduce((sum, channel) => sum + ((state.voiceStates.get(keyForText(server.id, channel.id)) || []).length), 0);
    const mentions = serverMentionCount(server);
    const unread = serverHasUnread(server);

    const card = el('button', {
      class: `home-card-item ${colorClassAt(cardIndex)}`,
      type: 'button',
      onclick: () => openServer(server.id)
    },
      el('span', { class: 'hc-top' },
        el('span', { class: 'hc-icon', text: server.icon || initials(server.name) }),
        el('span', { class: 'hc-arrow' }, icon('i-chevron'))
      ),
      el('span', { class: 'hc-name', text: server.name }),
      el('span', { class: 'hc-pills' },
        el('span', { class: 'pill-chip', text: `${server.members.length} member${server.members.length === 1 ? '' : 's'}` }),
        el('span', { class: 'pill-chip', text: `${server.channels.length} channels` }),
        liveCount ? el('span', { class: 'pill-chip live', text: `● ${liveCount} in voice` }) : null,
        mentions ? el('span', { class: 'pill-chip alert', text: `${mentions} ping${mentions === 1 ? '' : 's'}` }) : null,
        !mentions && unread ? el('span', { class: 'pill-chip', text: 'new messages' }) : null,
        server.temp ? el('span', { class: 'pill-chip', text: `closes in ${formatRemaining(server.expiresAt)}` }) : null
      )
    );
    card.style.setProperty('animation-delay', `${cardIndex * 45}ms`);
    ui.homeServerCards.append(card);
    cardIndex += 1;
  }
}

function renderMainView() {
  const view = state.view;
  ui.homeView.hidden = view.kind !== 'home';
  if (view.kind === 'home') {
    renderHome();
  }
  const chatShown = view.kind === 'text' || view.kind === 'dm' ||
    (view.kind === 'voice' && state.voiceChatOpen);
  ui.chatView.hidden = !chatShown;
  ui.voiceView.hidden = view.kind !== 'voice';
  ui.contentStack.classList.toggle('voice-chat', view.kind === 'voice' && state.voiceChatOpen);
  ui.voiceChatButton.hidden = view.kind !== 'voice';
  ui.voiceChatButton.setAttribute('aria-pressed', String(state.voiceChatOpen));

  // Level-2 animation: slide the pane in whenever the destination changes.
  const signature = `${view.kind}:${view.serverId || ''}:${view.channelId || view.dmId || ''}`;
  if (signature !== lastViewSignature) {
    lastViewSignature = signature;
    const pane = view.kind === 'voice' ? ui.voiceView : view.kind === 'home' ? ui.homeView : ui.chatView;
    pane.classList.remove('view-anim');
    void pane.offsetWidth; // restart the animation
    pane.classList.add('view-anim');
  }

  const inServer = view.kind === 'text' || view.kind === 'voice';
  const server = inServer ? getServer(view.serverId) : null;
  ui.invitePeopleButton.hidden = !server;
  ui.toggleMembersButton.hidden = !(view.kind === 'text' && server);
  ui.memberPanel.hidden = !(view.kind === 'text' && server && state.memberPanelOpen);

  if (view.kind === 'home') {
    ui.channelIcon.replaceChildren(icon('i-logo'));
    ui.channelTitle.textContent = 'Welcome';
    ui.channelTopic.textContent = 'Create or join a server to get talking';
  } else if (view.kind === 'dm') {
    const dm = state.dms.get(view.dmId);
    const user = dm ? getUser(dm.otherUserId) : null;
    ui.channelIcon.replaceChildren(user ? avatarEl(user) : icon('i-users'));
    const dmAvatar = ui.channelIcon.querySelector('.avatar');
    if (dmAvatar) {
      dmAvatar.style.width = '24px';
      dmAvatar.style.height = '24px';
      dmAvatar.style.fontSize = '10px';
    }
    ui.channelTitle.textContent = user ? user.name : 'Direct message';
    ui.channelTopic.textContent = user && user.username ? `@${user.username}` : user && user.guest ? 'Guest' : '';
  } else {
    const channel = getChannel(view.serverId, view.channelId);
    ui.channelIcon.replaceChildren(icon(view.kind === 'voice' ? 'i-speaker' : 'i-hash'));
    ui.channelTitle.textContent = channel ? channel.name : '';
    ui.channelTopic.textContent = channel ? channel.topic || '' : '';
  }

  if (view.kind === 'text' || view.kind === 'dm' || view.kind === 'voice') {
    ui.composerInput.placeholder = view.kind === 'dm'
      ? `Message @${ui.channelTitle.textContent}`
      : `Message #${ui.channelTitle.textContent}`;
  }

  renderMembers();
  renderVoiceView();
}

function renderMembers() {
  if (ui.memberPanel.hidden) {
    return;
  }
  const server = getServer(state.view.serverId);
  if (!server) {
    return;
  }

  const groups = { online: [], offline: [] };
  for (const member of server.members) {
    const user = getUser(member.userId);
    (state.online.has(member.userId) ? groups.online : groups.offline).push({ member, user });
  }
  const roleRank = { owner: 0, admin: 1, member: 2 };
  const sorter = (a, b) =>
    (roleRank[a.member.role] - roleRank[b.member.role]) || a.user.name.localeCompare(b.user.name);
  groups.online.sort(sorter);
  groups.offline.sort(sorter);

  ui.memberList.replaceChildren();
  for (const [label, entries] of [[`Online — ${groups.online.length}`, groups.online], [`Offline — ${groups.offline.length}`, groups.offline]]) {
    if (!entries.length) {
      continue;
    }
    ui.memberList.append(el('p', { class: 'member-group-label', text: label }));
    for (const { member, user } of entries) {
      const avatarWrap = el('span', { class: 'member-avatar-wrap' },
        avatarEl(user),
        el('span', { class: `presence-dot${state.online.has(user.id) ? ' online' : ''}` })
      );
      const item = el('button', {
        class: `member-item${state.online.has(user.id) ? '' : ' is-offline'}`,
        type: 'button',
        onclick: (event) => openUserPopover(event.currentTarget, user, server)
      },
        avatarWrap,
        el('span', { class: 'member-text' },
          el('span', { class: 'member-name' },
            user.name,
            user.pronouns ? el('span', { class: 'member-pronouns', text: user.pronouns }) : null,
            member.role === 'owner' ? icon('i-crown', 'role-owner-icon') : null,
            member.role === 'admin' ? icon('i-shield', 'role-admin-icon') : null,
            user.guest ? el('span', { class: 'guest-chip', text: 'guest' }) : null
          ),
          user.status ? el('small', {
            class: 'member-status',
            text: `${user.status.emoji ? `${user.status.emoji} ` : ''}${user.status.text}`.trim()
          }) : null
        )
      );
      ui.memberList.append(item);
    }
  }
}

// ============================================================== navigation

function setView(view) {
  state.view = view;
  state.mobilePane = view.kind === 'home' ? 'home' : 'content';
  state.voiceChatOpen = false;
  closePopovers();
  cancelReply();
  stopEditing();
  state.mentionTokens.clear();
  renderAll();
}

function openHome() {
  setView({ kind: 'home' });
}

function openServer(serverId) {
  const server = getServer(serverId);
  if (!server) {
    return;
  }
  const firstText = server.channels.find((channel) => channel.type === 'text');
  const firstVoice = server.channels.find((channel) => channel.type === 'voice');

  if (isMobile()) {
    // Phone flow: land on the channel-list screen, don't auto-open a chat
    // (that would mark it read before the person ever saw it).
    const channel = firstText || firstVoice;
    if (channel) {
      setView({ kind: channel.type === 'text' ? 'text' : 'voice', serverId, channelId: channel.id });
      state.mobilePane = 'nav';
      applyMobileLayout();
    }
    return;
  }

  if (firstText) {
    openTextChannel(serverId, firstText.id);
  } else if (firstVoice) {
    openVoiceChannel(serverId, firstVoice.id);
  }
}

function openTextChannel(serverId, channelId) {
  setView({ kind: 'text', serverId, channelId });
  openChat(keyForText(serverId, channelId));
}

function openDm(dmId) {
  setView({ kind: 'dm', dmId });
  openChat(keyForDm(dmId));
}

function openVoiceChannel(serverId, channelId) {
  setView({ kind: 'voice', serverId, channelId });
}

// ============================================================== chat view

async function openChat(channelKey) {
  msgEls.clear();
  ui.messageList.replaceChildren();
  ui.typingBar.replaceChildren();
  ui.loadOlderButton.hidden = true;
  renderChatIntro();

  let bucket = state.messages.get(channelKey);
  if (!bucket) {
    bucket = { list: [], hasMore: false, loaded: false };
    state.messages.set(channelKey, bucket);
  }

  if (!bucket.loaded) {
    try {
      const ack = await socket.request('messages', { channelKey });
      if (activeChannelKey() !== channelKey) {
        return;
      }
      for (const [id, user] of Object.entries(ack.users || {})) {
        state.users.set(id, { ...state.users.get(id), ...user });
      }
      bucket.list = ack.messages || [];
      bucket.hasMore = Boolean(ack.hasMore);
      bucket.loaded = true;
    } catch (error) {
      toast(error.message, true);
      return;
    }
  }

  rebuildMessageList(channelKey);
  scrollToBottom();
  markRead(channelKey);
}

function renderChatIntro() {
  const view = state.view;
  ui.chatIntro.replaceChildren();
  if (view.kind === 'text') {
    const channel = getChannel(view.serverId, view.channelId);
    if (channel) {
      ui.chatIntro.append(
        el('span', { class: 'intro-icon' }, icon('i-hash')),
        el('h3', { text: `Welcome to #${channel.name}` }),
        el('p', { text: channel.topic || 'This is the start of the channel.' })
      );
    }
  } else if (view.kind === 'dm') {
    const dm = state.dms.get(view.dmId);
    const user = dm ? getUser(dm.otherUserId) : null;
    if (user) {
      ui.chatIntro.append(
        avatarEl(user),
        el('h3', { text: user.name }),
        el('p', { text: `This is the beginning of your direct message history with ${user.name}.` })
      );
      const introAvatar = ui.chatIntro.querySelector('.avatar');
      introAvatar.style.width = '52px';
      introAvatar.style.height = '52px';
      introAvatar.style.fontSize = '19px';
    }
  }
}

function rebuildMessageList(channelKey) {
  const bucket = state.messages.get(channelKey);
  if (!bucket) {
    return;
  }
  msgEls.clear();
  ui.messageList.replaceChildren();
  ui.loadOlderButton.hidden = !bucket.hasMore;

  let previous = null;
  for (const message of bucket.list) {
    appendMessageRow(channelKey, message, previous);
    previous = message;
  }

  // Stagger the most recent rows into view (level-3 animation).
  const rows = ui.messageList.querySelectorAll('.msg');
  const start = Math.max(0, rows.length - 18);
  for (let index = start; index < rows.length; index += 1) {
    rows[index].classList.add('msg-stagger');
    rows[index].style.setProperty('--i', String(index - start));
  }
}

function appendMessageRow(channelKey, message, previous) {
  if (!previous || !sameDay(previous.createdAt, message.createdAt)) {
    ui.messageList.append(el('li', { class: 'day-divider', text: formatDay(message.createdAt) }));
  }
  const compact = Boolean(previous &&
    previous.authorId === message.authorId &&
    !message.replyTo && !previous.deleted &&
    sameDay(previous.createdAt, message.createdAt) &&
    message.createdAt - previous.createdAt < 5 * 60 * 1000);

  const row = buildMessageRow(channelKey, message, compact);
  ui.messageList.append(row);
  msgEls.set(message.id, row);
}

function buildMessageRow(channelKey, message, compact) {
  const author = getUser(message.authorId);
  const row = el('li', { class: `msg${compact ? ' is-compact' : ''}`, dataset: { id: message.id, compact: String(compact) } });
  if (!message.deleted && Array.isArray(message.mentions) && message.mentions.includes(state.me.id)) {
    row.classList.add('is-mention');
  }

  const gutter = el('div', { class: 'msg-gutter' });
  if (compact) {
    gutter.append(el('span', { class: 'msg-hover-time', text: formatTime(message.createdAt) }));
  } else {
    const avatar = avatarEl(author);
    avatar.addEventListener('click', (event) => openUserPopover(event.currentTarget, author, currentServerForView()));
    gutter.append(avatar);
  }

  const body = el('div', { class: 'msg-body' });

  if (message.replyTo) {
    const bucket = state.messages.get(channelKey);
    const target = bucket ? bucket.list.find((candidate) => candidate.id === message.replyTo) : null;
    const targetAuthor = target ? getUser(target.authorId) : null;
    body.append(el('div', { class: 'msg-reply-ref' },
      icon('i-reply'),
      el('strong', { text: targetAuthor ? targetAuthor.name : 'Original message' }),
      el('span', { text: target ? contentPreview(target, state.users) : 'not loaded' })
    ));
  }

  if (!compact) {
    const server = currentServerForView();
    const member = server ? server.members.find((candidate) => candidate.userId === message.authorId) : null;
    const authorButton = el('button', {
      class: `msg-author${member ? ` role-${member.role}` : ''}`,
      type: 'button',
      text: author.name,
      onclick: (event) => openUserPopover(event.currentTarget, author, server)
    });
    body.append(el('div', { class: 'msg-head' },
      authorButton,
      author.guest ? el('span', { class: 'guest-chip', text: 'guest' }) : null,
      el('span', { class: 'msg-time', title: formatFull(message.createdAt), text: formatTimeSmart(message.createdAt) })
    ));
  }

  body.append(buildMessageContent(message));
  row.append(gutter, body);

  if (!message.deleted) {
    row.append(buildMessageActions(channelKey, message));
  }
  return row;
}

function formatTimeSmart(ts) {
  return sameDay(ts, Date.now()) ? `today at ${formatTime(ts)}` : formatFull(ts);
}

function buildMessageContent(message) {
  const wrap = el('div', { class: 'msg-content-wrap' });

  const content = el('div', { class: 'msg-content' });
  if (message.deleted) {
    content.classList.add('is-deleted');
    content.textContent = 'This message was deleted';
  } else {
    content.append(renderContent(message.content, state.users));
    if (message.editedAt) {
      content.append(el('span', { class: 'msg-edited', text: ' (edited)' }));
    }
  }
  wrap.append(content);

  if (!message.deleted && message.attachments && message.attachments.length) {
    const attachments = el('div', { class: 'msg-attachments' });
    for (const attachment of message.attachments) {
      attachments.append(buildAttachment(attachment));
    }
    wrap.append(attachments);
  }

  if (!message.deleted && message.reactions && Object.keys(message.reactions).length) {
    wrap.append(buildReactions(message));
  }
  return wrap;
}

function buildAttachment(attachment) {
  const type = attachment.type || '';
  if (/^video\//.test(type)) {
    return el('span', { class: 'attachment-media' },
      el('video', { controls: true, preload: 'metadata', src: attachment.url })
    );
  }
  if (/^audio\//.test(type) || /^voice-message/.test(attachment.name || '')) {
    return el('span', { class: 'attachment-voice' },
      el('span', { class: 'voice-chip' }, icon('i-mic'), 'Voice message'),
      el('audio', { controls: true, preload: 'metadata', src: attachment.url })
    );
  }
  const isImage = /^image\//.test(type);
  if (isImage) {
    const img = el('img', { src: attachment.url, alt: attachment.name, loading: 'lazy' });
    const button = el('button', { class: 'attachment-image', type: 'button', title: attachment.name }, img);
    button.addEventListener('click', () => {
      ui.lightbox.querySelector('img').src = attachment.url;
      ui.lightbox.hidden = false;
    });
    return button;
  }
  return el('a', {
    class: 'attachment-file',
    href: attachment.url,
    download: attachment.name,
    target: '_blank',
    rel: 'noopener'
  },
    icon('i-download'),
    el('span', { class: 'file-meta' },
      el('span', { class: 'file-name', text: attachment.name }),
      el('span', { class: 'file-size', text: formatBytes(attachment.size) })
    )
  );
}

function buildReactions(message) {
  const channelKey = activeChannelKey();
  const wrap = el('div', { class: 'msg-reactions' });
  for (const [emoji, userIds] of Object.entries(message.reactions)) {
    const mine = userIds.includes(state.me.id);
    const names = userIds.slice(0, 6).map((id) => getUser(id).name).join(', ');
    const chip = el('button', {
      class: `reaction-chip${mine ? ' is-mine' : ''}`,
      type: 'button',
      title: names,
      onclick: () => socket.request('react', { channelKey, messageId: message.id, emoji, on: !mine }).catch((error) => toast(error.message, true))
    }, emoji, el('b', { text: String(userIds.length) }));
    wrap.append(chip);
  }
  const add = el('button', {
    class: 'reaction-chip reaction-add',
    type: 'button',
    'aria-label': 'Add reaction',
    onclick: (event) => {
      const anchor = event.currentTarget.getBoundingClientRect();
      openEmojiPopup(event.currentTarget, (emoji) => {
        fx.emojiBurst(anchor.left + anchor.width / 2, anchor.top, emoji);
        socket.request('react', { channelKey, messageId: message.id, emoji, on: true }).catch((error) => toast(error.message, true));
      });
    }
  }, icon('i-emoji'));
  wrap.append(add);
  return wrap;
}

function buildMessageActions(channelKey, message) {
  const actions = el('div', { class: 'msg-actions' });
  actions.append(el('button', {
    class: 'icon-button', type: 'button', title: 'Add reaction',
    onclick: (event) => {
      const anchor = event.currentTarget.getBoundingClientRect();
      openEmojiPopup(event.currentTarget, (emoji) => {
        fx.emojiBurst(anchor.left + anchor.width / 2, anchor.top, emoji);
        socket.request('react', { channelKey, messageId: message.id, emoji, on: true }).catch((error) => toast(error.message, true));
      });
    }
  }, icon('i-emoji')));

  actions.append(el('button', {
    class: 'icon-button', type: 'button', title: 'Reply',
    onclick: () => startReply(message)
  }, icon('i-reply')));

  if (message.authorId === state.me.id) {
    actions.append(el('button', {
      class: 'icon-button', type: 'button', title: 'Edit',
      onclick: () => startEditing(message)
    }, icon('i-edit')));
  }

  const server = currentServerForView();
  const mayDelete = message.authorId === state.me.id || (server && isModerator(server));
  if (mayDelete) {
    actions.append(el('button', {
      class: 'icon-button danger', type: 'button', title: 'Delete',
      onclick: (event) => {
        if (event.shiftKey) {
          deleteMessage(channelKey, message.id);
          return;
        }
        confirmModal('Delete message', 'This message will be removed for everyone. Hold Shift while clicking delete to skip this confirmation.', 'Delete', () => deleteMessage(channelKey, message.id));
      }
    }, icon('i-trash')));
  }
  return actions;
}

function deleteMessage(channelKey, messageId) {
  socket.request('del-msg', { channelKey, messageId }).catch((error) => toast(error.message, true));
}

function currentServerForView() {
  return (state.view.kind === 'text' || state.view.kind === 'voice') ? getServer(state.view.serverId) : null;
}

function insertMessage(channelKey, message) {
  let bucket = state.messages.get(channelKey);
  if (!bucket) {
    bucket = { list: [], hasMore: false, loaded: false };
    state.messages.set(channelKey, bucket);
  }
  if (bucket.list.some((candidate) => candidate.id === message.id)) {
    return;
  }
  bucket.list.push(message);
  if (bucket.list.length > 900) {
    bucket.list.splice(0, bucket.list.length - 900);
    bucket.hasMore = true;
  }

  if (activeChannelKey() === channelKey && !ui.chatView.hidden) {
    const wasNearBottom = nearBottom();
    const previous = bucket.list.length > 1 ? bucket.list[bucket.list.length - 2] : null;
    appendMessageRow(channelKey, message, previous);
    const row = msgEls.get(message.id);
    if (row) {
      row.classList.add('msg-in');
    }
    if (wasNearBottom || message.authorId === state.me.id) {
      scrollToBottom();
    }
    if (document.hasFocus() && wasNearBottom) {
      markRead(channelKey);
    }
  }
}

function applyMessageUpdate(channelKey, message) {
  const bucket = state.messages.get(channelKey);
  if (!bucket) {
    return;
  }
  const index = bucket.list.findIndex((candidate) => candidate.id === message.id);
  if (index === -1) {
    return;
  }
  bucket.list[index] = message;

  const row = msgEls.get(message.id);
  if (row && activeChannelKey() === channelKey) {
    const compact = row.dataset.compact === 'true';
    const fresh = buildMessageRow(channelKey, message, compact);
    row.replaceWith(fresh);
    msgEls.set(message.id, fresh);
  }
}

function nearBottom() {
  const node = ui.messageScroll;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
}

function scrollToBottom() {
  ui.messageScroll.scrollTop = ui.messageScroll.scrollHeight;
}

const sendRead = debounce((channelKey) => {
  socket.push('read', { channelKey, ts: Date.now() });
}, 350);

function markRead(channelKey) {
  const hadMentions = state.mentions[channelKey];
  state.lastRead[channelKey] = Date.now();
  if (hadMentions) {
    delete state.mentions[channelKey];
  }
  sendRead(channelKey);
  renderRail();
  renderSidebar();
  updateTitle();
}

async function loadOlder() {
  const channelKey = activeChannelKey();
  const bucket = state.messages.get(channelKey);
  if (!bucket || !bucket.list.length) {
    return;
  }
  ui.loadOlderButton.disabled = true;
  try {
    const ack = await socket.request('messages', { channelKey, beforeId: bucket.list[0].id });
    for (const [id, user] of Object.entries(ack.users || {})) {
      state.users.set(id, { ...state.users.get(id), ...user });
    }
    const fresh = (ack.messages || []).filter(
      (message) => !bucket.list.some((candidate) => candidate.id === message.id)
    );
    bucket.list = fresh.concat(bucket.list);
    bucket.hasMore = Boolean(ack.hasMore);

    const anchor = ui.messageList.firstElementChild;
    const offset = anchor ? anchor.getBoundingClientRect().top : 0;
    rebuildMessageList(channelKey);
    if (anchor && anchor.dataset && anchor.dataset.id) {
      const restored = msgEls.get(anchor.dataset.id);
      if (restored) {
        ui.messageScroll.scrollTop += restored.getBoundingClientRect().top - offset;
      }
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    ui.loadOlderButton.disabled = false;
  }
}

// ============================================================== typing

function renderTyping() {
  const channelKey = activeChannelKey();
  ui.typingBar.replaceChildren();
  if (!channelKey) {
    return;
  }
  const entries = state.typing.get(channelKey);
  if (!entries || !entries.size) {
    return;
  }
  const now = Date.now();
  const names = [];
  for (const [userId, expiresAt] of entries) {
    if (expiresAt < now) {
      entries.delete(userId);
    } else if (userId !== state.me.id) {
      names.push(getUser(userId).name);
    }
  }
  if (!names.length) {
    return;
  }
  const label = names.length === 1
    ? `${names[0]} is typing…`
    : names.length === 2
      ? `${names[0]} and ${names[1]} are typing…`
      : 'Several people are typing…';
  ui.typingBar.append(
    el('span', { class: 'dots' }, el('i'), el('i'), el('i')),
    label
  );
}

setInterval(renderTyping, 1200);

setInterval(() => {
  if (!voice.active || !voice.joinedAt) {
    ui.callTimer.textContent = '00:00';
    return;
  }
  const seconds = Math.floor((Date.now() - voice.joinedAt) / 1000);
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  ui.callTimer.textContent = hh
    ? `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}, 1000);

// ============================================================== composer

let lastTypingSentAt = 0;

function autoSizeComposer() {
  ui.composerInput.style.height = 'auto';
  ui.composerInput.style.height = `${Math.min(ui.composerInput.scrollHeight, 200)}px`;
}

function composerAudience() {
  const view = state.view;
  if (view.kind === 'text') {
    const server = getServer(view.serverId);
    return server ? server.members.map((member) => getUser(member.userId)) : [];
  }
  if (view.kind === 'dm') {
    const dm = state.dms.get(view.dmId);
    return dm ? [getUser(dm.otherUserId)] : [];
  }
  return [];
}

function tokenizeMentions(raw) {
  let content = raw;
  const names = Array.from(state.mentionTokens.keys()).sort((a, b) => b.length - a.length);
  for (const name of names) {
    const id = state.mentionTokens.get(name);
    content = content.split(`@${name}`).join(`<@${id}>`);
  }
  return content;
}

function detokenizeMentions(content) {
  return String(content || '').replace(/<@(u_[a-z0-9]+)>/g, (whole, id) => {
    const user = state.users.get(id);
    if (user) {
      state.mentionTokens.set(user.name, id);
      return `@${user.name}`;
    }
    return whole;
  });
}

const CHATTY_KINDS = new Set(['text', 'dm', 'voice']);

async function sendCurrentMessage() {
  const channelKey = activeChannelKey();
  if (!channelKey || !CHATTY_KINDS.has(state.view.kind)) {
    return;
  }
  if (state.pendingAttachments.some((entry) => entry.uploading)) {
    toast('Hold on — files are still uploading.');
    return;
  }
  const raw = ui.composerInput.value;
  const content = tokenizeMentions(raw).trim();
  const attachments = state.pendingAttachments.map((entry) => entry.attachment).filter(Boolean);

  if (state.editingId) {
    const messageId = state.editingId;
    if (!content) {
      stopEditing();
      return;
    }
    try {
      await socket.request('edit', { channelKey, messageId, content });
      stopEditing();
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }

  if (!content && !attachments.length) {
    return;
  }

  ui.composerInput.value = '';
  autoSizeComposer();
  const replyTo = state.replyTo ? state.replyTo.id : null;
  cancelReply();
  clearAttachments();
  state.mentionTokens.clear();

  try {
    const ack = await socket.request('send', { channelKey, content, attachments, replyTo });
    insertMessage(ack.channelKey, ack.message);
    bumpChannelActivity(ack.channelKey, ack.message.createdAt);
    state.lastRead[ack.channelKey] = ack.message.createdAt + 1;
    renderSidebar();
    renderRail();
    fx.ping(ui.sendButton);
  } catch (error) {
    toast(error.message, true);
    ui.composerInput.value = raw;
    autoSizeComposer();
  }
}

function startReply(message) {
  stopEditing();
  state.replyTo = message;
  ui.replyBarName.textContent = getUser(message.authorId).name;
  ui.replyBar.hidden = false;
  ui.composerInput.focus();
}

function cancelReply() {
  state.replyTo = null;
  ui.replyBar.hidden = true;
}

function startEditing(message) {
  cancelReply();
  state.editingId = message.id;
  ui.composerInput.value = detokenizeMentions(message.content);
  autoSizeComposer();
  ui.composerInput.focus();
  ui.composerInput.setSelectionRange(ui.composerInput.value.length, ui.composerInput.value.length);
  ui.replyBarName.textContent = '';
  ui.replyBar.hidden = false;
  ui.replyBar.firstElementChild.textContent = 'Editing message — Enter to save, Esc to cancel';
}

function stopEditing() {
  if (!state.editingId) {
    return;
  }
  state.editingId = null;
  ui.composerInput.value = '';
  autoSizeComposer();
  ui.replyBar.hidden = true;
  const label = ui.replyBar.firstElementChild;
  label.replaceChildren('Replying to ', el('strong', { id: 'replyBarName' }));
  ui.replyBarName = label.querySelector('strong') || ui.replyBarName;
}

// -------- attachments

function clearAttachments() {
  state.pendingAttachments = [];
  renderAttachPreview();
}

function renderAttachPreview() {
  ui.attachPreview.replaceChildren();
  ui.attachPreview.hidden = !state.pendingAttachments.length;
  for (const entry of state.pendingAttachments) {
    const chip = el('span', { class: `attach-chip${entry.uploading ? ' is-uploading' : ''}` });
    if (entry.attachment && /^image\//.test(entry.attachment.type)) {
      chip.append(el('img', { src: entry.attachment.url, alt: '' }));
    } else {
      chip.append(icon('i-attach'));
    }
    chip.append(el('span', { class: 'attach-name', text: entry.name }));
    chip.append(el('button', {
      class: 'icon-button tiny', type: 'button', 'aria-label': 'Remove attachment',
      onclick: () => {
        state.pendingAttachments = state.pendingAttachments.filter((candidate) => candidate !== entry);
        renderAttachPreview();
      }
    }, icon('i-x')));
    ui.attachPreview.append(chip);
  }
}

async function uploadFiles(files) {
  for (const file of files) {
    if (state.pendingAttachments.length >= 6) {
      toast('You can attach up to 6 files per message.');
      break;
    }
    const entry = { name: file.name, uploading: true, attachment: null };
    state.pendingAttachments.push(entry);
    renderAttachPreview();
    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'X-File-Name': btoa(unescape(encodeURIComponent(file.name || 'file'))),
          'Content-Type': 'application/octet-stream'
        },
        body: file
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Upload failed.');
      }
      entry.attachment = data.attachment;
      entry.uploading = false;
    } catch (error) {
      state.pendingAttachments = state.pendingAttachments.filter((candidate) => candidate !== entry);
      toast(error.message, true);
    }
    renderAttachPreview();
  }
}

// -------- mention autocomplete

const mentionState = { open: false, matches: [], highlighted: 0, start: 0 };

function updateMentionPopup() {
  const input = ui.composerInput;
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const match = before.match(/(?:^|\s)@([\w.\- ]{0,30})$/);
  if (!match || (state.view.kind !== 'text' && state.view.kind !== 'dm')) {
    closeMentionPopup();
    return;
  }
  const query = match[1].toLowerCase();
  const audience = composerAudience().filter((user) => user.id !== state.me.id);
  const matches = audience
    .filter((user) => user.name.toLowerCase().includes(query) || (user.username || '').includes(query))
    .slice(0, 8);
  if (!matches.length) {
    closeMentionPopup();
    return;
  }

  mentionState.open = true;
  mentionState.matches = matches;
  mentionState.highlighted = Math.min(mentionState.highlighted, matches.length - 1);
  mentionState.start = caret - match[1].length - 1;

  ui.mentionPopup.replaceChildren();
  matches.forEach((user, index) => {
    const option = el('button', {
      class: `mention-option${index === mentionState.highlighted ? ' is-highlighted' : ''}`,
      type: 'button',
      onclick: () => pickMention(index)
    },
      avatarEl(user),
      el('span', { text: user.name }),
      user.username ? el('small', { text: ` @${user.username}`, style: 'color: var(--text-faint)' }) : null
    );
    ui.mentionPopup.append(option);
  });

  const rect = ui.composerInput.getBoundingClientRect();
  ui.mentionPopup.hidden = false;
  ui.mentionPopup.style.left = `${rect.left}px`;
  ui.mentionPopup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  ui.mentionPopup.style.top = 'auto';
}

function pickMention(index) {
  const user = mentionState.matches[index];
  if (!user) {
    return;
  }
  const input = ui.composerInput;
  const caret = input.selectionStart;
  state.mentionTokens.set(user.name, user.id);
  input.value = `${input.value.slice(0, mentionState.start)}@${user.name} ${input.value.slice(caret)}`;
  const position = mentionState.start + user.name.length + 2;
  input.setSelectionRange(position, position);
  input.focus();
  closeMentionPopup();
  autoSizeComposer();
}

function closeMentionPopup() {
  mentionState.open = false;
  ui.mentionPopup.hidden = true;
}

// ------------------------------------------------------- voice messages

const rec = { recorder: null, timer: null, chunks: [], startedAt: 0, cancelled: false };

function recTimeText() {
  const seconds = Math.floor((Date.now() - rec.startedAt) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function startVoiceRecording() {
  const channelKey = activeChannelKey();
  if (rec.recorder || !channelKey || !CHATTY_KINDS.has(state.view.kind)) {
    return;
  }
  if (typeof MediaRecorder === 'undefined') {
    toast('Voice messages are not supported in this browser.', true);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch {
    toast('Microphone access was blocked.', true);
    return;
  }

  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  rec.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  rec.chunks = [];
  rec.cancelled = false;
  rec.startedAt = Date.now();

  rec.recorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size) {
      rec.chunks.push(event.data);
    }
  });
  rec.recorder.addEventListener('stop', async () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    const wasCancelled = rec.cancelled;
    const durationMs = Date.now() - rec.startedAt;
    const blob = new Blob(rec.chunks, { type: 'audio/webm' });
    rec.recorder = null;
    rec.chunks = [];
    if (wasCancelled || durationMs < 600 || blob.size < 300) {
      return;
    }
    await sendVoiceMessage(blob);
  });

  rec.recorder.start(250);
  ui.recBar.hidden = false;
  ui.voiceMsgButton.classList.add('is-rec');
  ui.recTime.textContent = '0:00';
  rec.timer = setInterval(() => {
    ui.recTime.textContent = recTimeText();
    if (Date.now() - rec.startedAt > 5 * 60 * 1000) {
      stopVoiceRecording(false); // hard cap at five minutes
    }
  }, 500);
}

function stopVoiceRecording(cancel) {
  if (!rec.recorder) {
    return;
  }
  rec.cancelled = cancel;
  clearInterval(rec.timer);
  ui.recBar.hidden = true;
  ui.voiceMsgButton.classList.remove('is-rec');
  try {
    rec.recorder.stop();
  } catch {
    rec.recorder = null;
  }
}

async function sendVoiceMessage(blob) {
  const channelKey = activeChannelKey();
  if (!channelKey || !CHATTY_KINDS.has(state.view.kind)) {
    return;
  }
  try {
    const fileName = `voice-message-${Date.now()}.webm`;
    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        'X-File-Name': btoa(fileName),
        'Content-Type': 'application/octet-stream'
      },
      body: blob
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Upload failed.');
    }
    const attachment = { ...data.attachment, type: 'audio/webm', name: fileName };
    const ack = await socket.request('send', { channelKey, content: '', attachments: [attachment], replyTo: null });
    insertMessage(ack.channelKey, ack.message);
    bumpChannelActivity(ack.channelKey, ack.message.createdAt);
    state.lastRead[ack.channelKey] = ack.message.createdAt + 1;
    renderSidebar();
    renderRail();
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------------------------------------------- call keep-alive (lock screen)

let wakeLock = null;

async function syncCallKeepAlive() {
  const active = voice.active;
  try {
    if (active && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } else if (!active && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    wakeLock = null;
  }

  if ('mediaSession' in navigator) {
    try {
      if (active && voice.channelKey) {
        const [, serverId, channelId] = voice.channelKey.split(':');
        const channel = getChannel(serverId, channelId);
        navigator.mediaSession.metadata = new MediaMetadata({
          title: channel ? `Voice — ${channel.name}` : 'Roomly call',
          artist: 'Roomly',
          album: 'Call in progress'
        });
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setActionHandler('play', () => {});
        navigator.mediaSession.setActionHandler('pause', () => {});
      } else {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
      }
    } catch {}
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    return;
  }
  syncCallKeepAlive();
  if (voice.active) {
    try {
      voice.ensureAudioContext();
    } catch {}
    for (const audio of voiceAudioEls.values()) {
      audio.play().catch(() => {});
    }
  }
});

// ============================================================== voice view

function renderVoiceView() {
  if (state.view.kind !== 'voice') {
    return;
  }
  const { serverId, channelId } = state.view;
  const channel = getChannel(serverId, channelId);
  if (!channel) {
    return;
  }
  const channelKey = keyForText(serverId, channelId);
  const joinedHere = voice.active && voice.channelKey === channelKey;
  const participants = state.voiceStates.get(channelKey) || [];

  ui.voicePrejoin.hidden = joinedHere;
  ui.voiceStage.hidden = !joinedHere;

  if (!joinedHere) {
    ui.voicePrejoinTitle.textContent = channel.name;
    ui.voicePrejoinCount.textContent = participants.length
      ? `${participants.length} ${participants.length === 1 ? 'person is' : 'people are'} here (limit ${state.voiceLimit})`
      : 'No one is here yet. Be the first!';
    ui.voicePrejoinFaces.replaceChildren();
    for (const participant of participants.slice(0, 10)) {
      ui.voicePrejoinFaces.append(avatarEl(getUser(participant.userId)));
    }
    return;
  }

  renderVoiceTiles(channelKey, participants);
  renderVoiceControls();
  renderScreenStage(participants);
}

function renderVoiceTiles(channelKey, participants) {
  const seen = new Set();

  const ensureTile = (key, user, media, stream, isLocal, connected) => {
    seen.add(key);
    let tile = voiceTileEls.get(key);
    if (!tile) {
      tile = el('div', {
        class: 'voice-tile',
        dataset: { tileKey: key },
        title: 'Click to pin',
        onclick: () => togglePin(key)
      },
        el('video', { autoplay: true, playsinline: true, muted: true }),
        avatarEl(user),
        el('span', { class: 'voice-tile-conn', text: 'Connecting' }),
        el('span', { class: 'voice-tile-footer' }, el('span', { class: 'voice-tile-name' }))
      );
      voiceTileEls.set(key, tile);
      ui.voiceGrid.append(tile);
    }
    tile.classList.toggle('is-local', isLocal);
    tile.classList.toggle('is-connected', connected);
    tile.classList.toggle('is-pinned', state.pinned === key);
    tile.title = state.pinned === key ? 'Click to unpin' : 'Click to pin';

    const video = tile.querySelector('video');
    const cameraOn = Boolean(media && media.video && stream && stream.getVideoTracks().some((track) => track.readyState === 'live'));
    tile.classList.toggle('camera-on', cameraOn);
    if (stream && video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.muted = true; // audio plays through the persistent audio elements

    const nameEl = tile.querySelector('.voice-tile-name');
    nameEl.replaceChildren(...[
      user.name + (isLocal ? ' (you)' : ''),
      media && !media.audio ? icon('i-mic-off', 'tile-muted') : null,
      media && media.screen ? icon('i-screen', 'tile-sharing') : null
    ].filter(Boolean));
    return tile;
  };

  // Local tile first.
  ensureTile('self', state.me, voice.media(), voice.localStream, true, true);

  for (const participant of participants) {
    if (participant.connId === state.connId) {
      continue;
    }
    const peer = voice.peers.get(participant.connId);
    ensureTile(
      participant.connId,
      getUser(participant.userId),
      participant.media,
      peer ? peer.cameraStream : null,
      false,
      Boolean(peer && peer.connected)
    );
  }

  for (const [key, tile] of voiceTileEls) {
    if (!seen.has(key)) {
      tile.remove();
      voiceTileEls.delete(key);
    }
  }
  ui.voiceGrid.dataset.count = String(Math.min(seen.size, 9));
}

function renderVoiceControls() {
  const media = voice.media();
  ui.vMicButton.classList.toggle('is-off', !media.audio);
  ui.vMicButton.setAttribute('aria-pressed', String(media.audio));
  ui.vCamButton.classList.toggle('is-off', !media.video);
  ui.vCamButton.setAttribute('aria-pressed', String(media.video));
  ui.vScreenButton.classList.toggle('is-live', media.screen);
  ui.vScreenButton.setAttribute('aria-pressed', String(media.screen));
}

function togglePin(key) {
  state.pinned = state.pinned === key ? null : key;
  renderVoiceView();
}

function renderScreenStage(participants) {
  // A pinned participant takes the stage over everything else (Meet-style).
  let pinned = state.pinned;
  if (pinned && pinned !== 'self' && !participants.some((candidate) => candidate.connId === pinned)) {
    pinned = state.pinned = null;
  }
  ui.voiceStage.classList.toggle('pin-max', Boolean(pinned));
  if (pinned) {
    const isSelf = pinned === 'self';
    const participant = isSelf ? null : participants.find((candidate) => candidate.connId === pinned);
    const user = isSelf ? state.me : getUser(participant.userId);
    const media = isSelf ? voice.media() : participant.media || {};
    const stream = isSelf ? voice.localStream : (voice.peers.get(pinned) || {}).cameraStream;
    const camOn = Boolean(media.video && stream && stream.getVideoTracks().some((track) => track.readyState === 'live'));

    ui.screenStage.hidden = false;
    ui.voiceStage.classList.add('has-screen');
    ui.screenSelfNote.hidden = true;
    ui.unpinButton.hidden = false;
    ui.screenLabel.hidden = false;
    ui.screenLabel.replaceChildren(icon('i-cam'), ` ${user.name}${isSelf ? ' (you)' : ''} — pinned`);

    if (camOn) {
      ui.stageAvatar.hidden = true;
      ui.screenVideo.hidden = false;
      if (ui.screenVideo.srcObject !== stream) {
        ui.screenVideo.srcObject = stream;
      }
      ui.screenVideo.muted = true;
      ui.screenVideo.classList.toggle('mirror', isSelf);
    } else {
      ui.screenVideo.hidden = true;
      ui.screenVideo.srcObject = null;
      ui.stageAvatar.hidden = false;
      ui.stageAvatar.replaceChildren(
        avatarEl(user, 'stage-avatar-face'),
        el('strong', { text: user.name + (isSelf ? ' (you)' : '') }),
        el('small', { text: 'Camera is off' })
      );
    }
    return;
  }
  ui.unpinButton.hidden = true;
  ui.stageAvatar.hidden = true;
  ui.screenVideo.hidden = false;
  ui.screenVideo.classList.remove('mirror');
  renderShareStage(participants);
}

function renderShareStage(participants) {
  // Choose which screen share to feature.
  const sharers = [];
  if (voice.screenStream) {
    sharers.push({ key: 'self', stream: voice.screenStream, name: `${state.me.name} (you)` });
  }
  for (const participant of participants) {
    if (participant.connId === state.connId || !participant.media || !participant.media.screen) {
      continue;
    }
    const peer = voice.peers.get(participant.connId);
    if (peer && peer.screenStream) {
      sharers.push({ key: participant.connId, stream: peer.screenStream, name: getUser(participant.userId).name });
    }
  }

  if (!sharers.length) {
    state.focusedScreen = null;
    ui.screenStage.hidden = true;
    ui.voiceStage.classList.remove('has-screen');
    ui.screenVideo.srcObject = null;
    ui.screenSelfNote.hidden = true;
    return;
  }

  let focused = sharers.find((sharer) => sharer.key === state.focusedScreen);
  if (!focused) {
    focused = sharers.find((sharer) => sharer.key !== 'self') || sharers[0];
    state.focusedScreen = focused.key;
  }

  ui.screenStage.hidden = false;
  ui.voiceStage.classList.add('has-screen');

  const isSelf = focused.key === 'self';
  ui.screenSelfNote.hidden = !isSelf;
  ui.screenLabel.hidden = isSelf;
  if (isSelf) {
    // Never preview your own share back at you — that is an infinite mirror.
    if (ui.screenVideo.srcObject) {
      ui.screenVideo.srcObject = null;
    }
  } else {
    if (ui.screenVideo.srcObject !== focused.stream) {
      ui.screenVideo.srcObject = focused.stream;
    }
    ui.screenVideo.muted = true;
    ui.screenLabel.replaceChildren(icon('i-screen'), ` ${focused.name} is sharing`);
  }
}

/** Remote audio must survive leaving the voice view, so it lives in hidden elements. */
function syncVoiceAudio() {
  const wanted = new Set();
  if (voice.active) {
    for (const peer of voice.peers.values()) {
      if (peer.cameraStream && peer.cameraStream.getAudioTracks().length) {
        wanted.add(peer.connId);
        let audio = voiceAudioEls.get(peer.connId);
        if (!audio) {
          audio = el('audio', { autoplay: true });
          audio.style.display = 'none';
          document.body.append(audio);
          voiceAudioEls.set(peer.connId, audio);
        }
        if (audio.srcObject !== peer.cameraStream) {
          audio.srcObject = peer.cameraStream;
          audio.play().catch(() => {});
        }
      }
    }
  }
  for (const [connId, audio] of voiceAudioEls) {
    if (!wanted.has(connId)) {
      audio.srcObject = null;
      audio.remove();
      voiceAudioEls.delete(connId);
    }
  }
}

async function joinVoice(withCamera) {
  const { serverId, channelId } = state.view;
  const channelKey = keyForText(serverId, channelId);
  try {
    await voice.join(channelKey, { video: withCamera });
    beep('join');
  } catch (error) {
    const message = error && error.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in your browser settings.'
      : error.message || 'Could not join the voice channel.';
    toast(message, true);
  }
  renderVoiceView();
  renderVoiceDock();
  renderSidebar();
}

// ============================================================== popovers

function closePopovers() {
  ui.popover.hidden = true;
  ui.emojiPopup.hidden = true;
  closeMentionPopup();
}

function positionFloating(node, anchor) {
  const rect = anchor.getBoundingClientRect();
  node.style.visibility = 'hidden';
  node.hidden = false;
  const { width, height } = node.getBoundingClientRect();
  let left = Math.min(rect.left, window.innerWidth - width - 12);
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 12) {
    top = Math.max(12, rect.top - height - 8);
  }
  node.style.left = `${Math.max(12, left)}px`;
  node.style.top = `${top}px`;
  node.style.bottom = 'auto';
  node.style.visibility = 'visible';
}

function openUserPopover(anchor, user, server) {
  ui.popover.replaceChildren();
  const fresh = state.users.get(user.id) || user;

  ui.popover.append(el('div', { class: 'popover-head profile-head' },
    avatarEl(fresh, 'pop-avatar'),
    el('span', { class: 'pop-name' },
      el('strong', {},
        fresh.name,
        fresh.pronouns ? el('span', { class: 'pop-pronouns', text: fresh.pronouns }) : null
      ),
      el('small', { text: fresh.guest ? 'Guest account' : `@${fresh.username}` })
    )
  ));

  if (fresh.status) {
    ui.popover.append(el('div', {
      class: 'pop-status',
      text: `${fresh.status.emoji ? `${fresh.status.emoji} ` : ''}${fresh.status.text}`.trim()
    }));
  }

  const bioSlot = el('div', { class: 'pop-bio', hidden: true });
  ui.popover.append(bioSlot);
  socket.request('profile-full', { userId: fresh.id }).then((ack) => {
    if (ui.popover.hidden || !ui.popover.contains(bioSlot)) {
      return;
    }
    if (ack.bio) {
      bioSlot.hidden = false;
      bioSlot.replaceChildren(
        el('p', { class: 'pop-bio-label', text: 'About me' }),
        renderContent(ack.bio, state.users)
      );
    } else if (ack.detailsHidden && fresh.id !== state.me.id) {
      bioSlot.hidden = false;
      bioSlot.replaceChildren(el('p', { class: 'pop-bio-label dim', text: 'Profile details are private.' }));
    }
  }).catch(() => {});

  if (fresh.id !== state.me.id) {
    ui.popover.append(el('button', {
      class: 'popover-item', type: 'button',
      onclick: async () => {
        closePopovers();
        try {
          const ack = await socket.request('dm-open', { userId: fresh.id });
          state.users.set(ack.user.id, { ...state.users.get(ack.user.id), ...ack.user });
          if (ack.user.online) {
            state.online.add(ack.user.id);
          }
          state.dms.set(ack.dm.id, ack.dm);
          openDm(ack.dm.id);
        } catch (error) {
          toast(error.message, true);
        }
      }
    }, icon('i-users'), 'Send a direct message'));
  }

  if (server && fresh.id !== state.me.id) {
    const membership = server.members.find((member) => member.userId === fresh.id);
    if (server.myRole === 'owner' && membership) {
      const makeAdmin = membership.role !== 'admin';
      ui.popover.append(el('button', {
        class: 'popover-item', type: 'button',
        onclick: () => {
          closePopovers();
          socket.request('set-role', { serverId: server.id, userId: fresh.id, role: makeAdmin ? 'admin' : 'member' })
            .then(() => toast(makeAdmin ? `${fresh.name} is now an admin.` : `${fresh.name} is no longer an admin.`))
            .catch((error) => toast(error.message, true));
        }
      }, icon('i-shield'), makeAdmin ? 'Make server admin' : 'Remove admin role'));
    }
    if (canModerate(server, fresh.id)) {
      ui.popover.append(el('button', {
        class: 'popover-item danger', type: 'button',
        onclick: () => {
          closePopovers();
          confirmModal('Kick member', `${fresh.name} will be removed from ${server.name}. They can rejoin with an invite.`, 'Kick', () => {
            socket.request('kick', { serverId: server.id, userId: fresh.id }).catch((error) => toast(error.message, true));
          });
        }
      }, icon('i-x'), 'Kick from server'));
      ui.popover.append(el('button', {
        class: 'popover-item danger', type: 'button',
        onclick: () => {
          closePopovers();
          confirmModal('Ban member', `${fresh.name} will be removed from ${server.name} and won't be able to rejoin.`, 'Ban', () => {
            socket.request('ban', { serverId: server.id, userId: fresh.id }).catch((error) => toast(error.message, true));
          });
        }
      }, icon('i-trash'), 'Ban from server'));
    }
  }

  positionFloating(ui.popover, anchor);
}

function openServerMenu(anchor) {
  const server = currentServerForView();
  if (!server) {
    return;
  }
  ui.popover.replaceChildren();

  ui.popover.append(el('button', {
    class: 'popover-item', type: 'button',
    onclick: () => { closePopovers(); openInviteModal(server); }
  }, icon('i-link'), 'Invite people'));

  if (isModerator(server)) {
    ui.popover.append(el('button', {
      class: 'popover-item', type: 'button',
      onclick: () => { closePopovers(); openCreateChannelModal(server, 'text'); }
    }, icon('i-plus'), 'Create channel'));
    ui.popover.append(el('button', {
      class: 'popover-item', type: 'button',
      onclick: () => { closePopovers(); openServerSettings(server); }
    }, icon('i-settings'), 'Server settings'));
  }

  if (server.myRole !== 'owner') {
    ui.popover.append(el('button', {
      class: 'popover-item danger', type: 'button',
      onclick: () => {
        closePopovers();
        confirmModal('Leave server', `You will leave ${server.name}. You can rejoin later with an invite link.`, 'Leave', () => {
          socket.request('leave-server', { serverId: server.id }).catch((error) => toast(error.message, true));
        });
      }
    }, icon('i-logout'), 'Leave server'));
  } else {
    ui.popover.append(el('button', {
      class: 'popover-item danger', type: 'button',
      onclick: () => { closePopovers(); confirmDeleteServer(server); }
    }, icon('i-trash'), 'Delete server'));
  }

  positionFloating(ui.popover, anchor);
}

function openEmojiPopup(anchor, onPick) {
  ui.emojiPopup.replaceChildren();
  const grid = el('div', { class: 'emoji-grid' });
  const quick = el('div', { class: 'emoji-grid' });
  for (const emoji of QUICK_REACTIONS) {
    quick.append(el('button', { type: 'button', text: emoji, onclick: () => { ui.emojiPopup.hidden = true; onPick(emoji); } }));
  }
  ui.emojiPopup.append(el('p', { class: 'emoji-group-label', text: 'Quick' }), quick);
  for (const group of EMOJI_GROUPS) {
    grid.append(el('p', { class: 'emoji-group-label', text: group.label }));
    for (const emoji of group.emojis) {
      grid.append(el('button', { type: 'button', text: emoji, onclick: () => { ui.emojiPopup.hidden = true; onPick(emoji); } }));
    }
  }
  ui.emojiPopup.append(grid);
  positionFloating(ui.emojiPopup, anchor);
}

// ============================================================== modals

function openModal(build) {
  ui.modalCard.replaceChildren();
  ui.modalCard.append(el('button', { class: 'icon-button modal-close', type: 'button', 'aria-label': 'Close', onclick: closeModal }, icon('i-x')));
  build(ui.modalCard);
  ui.modalRoot.hidden = false;
  const firstInput = ui.modalCard.querySelector('input');
  if (firstInput) {
    firstInput.focus();
  }
}

function closeModal() {
  ui.modalRoot.hidden = true;
  ui.modalCard.replaceChildren();
}

function confirmModal(title, text, actionLabel, onConfirm) {
  openModal((card) => {
    card.append(
      el('h2', { text: title }),
      el('p', { class: 'modal-sub', text }),
      el('div', { class: 'modal-buttons' },
        el('button', { class: 'ghost-button', type: 'button', text: 'Cancel', onclick: closeModal }),
        el('button', {
          class: 'ghost-button danger', type: 'button', text: actionLabel,
          onclick: () => { closeModal(); onConfirm(); }
        })
      )
    );
  });
}

function openAddServerModal(initial = 'choose') {
  openModal((card) => {
    card.append(el('h2', { text: 'Add a server' }));
    const sub = el('p', { class: 'modal-sub', text: 'Create your own community, or join one with an invite.' });
    card.append(sub);

    const body = el('div', {});
    card.append(body);

    const showChoose = () => {
      body.replaceChildren(el('div', { class: 'choice-row' },
        el('button', { class: 'choice-card', type: 'button', onclick: showCreate }, icon('i-plus'), 'Create my own'),
        el('button', { class: 'choice-card', type: 'button', onclick: showJoin }, icon('i-link'), 'Join with invite')
      ));
    };

    const showCreate = () => {
      const nameInput = el('input', { type: 'text', maxlength: '50', placeholder: "e.g. Diaa's hangout" });
      const iconInput = el('input', { type: 'text', maxlength: '4', placeholder: '🚀 (optional emoji)' });
      const error = el('p', { class: 'form-error' });
      const form = el('form', {
        class: 'modal-form',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            const ack = await socket.request('create-server', { name: nameInput.value, icon: iconInput.value });
            closeModal();
            applyServerAdded(ack.server);
            openServer(ack.server.id);
            openInviteModal(ack.server);
          } catch (requestError) {
            error.textContent = requestError.message;
          }
        }
      },
        el('label', {}, 'Server name', nameInput),
        el('label', {}, 'Icon', iconInput),
        state.me.guest ? el('p', { class: 'temp-hint' },
          icon('i-refresh'),
          ` Guest servers are temporary — this one will close ${state.guestTtlHours} hours after creation, and you can host one at a time. Register a free account for unlimited permanent servers.`
        ) : null,
        error,
        el('div', { class: 'modal-buttons' },
          el('button', { class: 'ghost-button', type: 'button', text: 'Back', onclick: showChoose }),
          el('button', { class: 'primary-button', type: 'submit', text: state.me.guest ? 'Create temporary server' : 'Create server' })
        )
      );
      body.replaceChildren(form);
      nameInput.focus();
    };

    const showJoin = () => {
      const codeInput = el('input', { type: 'text', maxlength: '120', placeholder: 'Invite code or link' });
      const error = el('p', { class: 'form-error' });
      const form = el('form', {
        class: 'modal-form',
        onsubmit: async (event) => {
          event.preventDefault();
          const raw = codeInput.value.trim();
          const match = raw.match(/invite\/([a-z0-9]+)/i);
          const code = (match ? match[1] : raw).toLowerCase();
          try {
            const ack = await socket.request('join-invite', { code });
            closeModal();
            applyServerAdded(ack.server, ack.users);
            openServer(ack.server.id);
            toast(`Welcome to ${ack.server.name}!`);
          } catch (requestError) {
            error.textContent = requestError.message;
          }
        }
      },
        el('label', {}, 'Invite', codeInput),
        error,
        el('div', { class: 'modal-buttons' },
          el('button', { class: 'ghost-button', type: 'button', text: 'Back', onclick: showChoose }),
          el('button', { class: 'primary-button', type: 'submit', text: 'Join server' })
        )
      );
      body.replaceChildren(form);
      codeInput.focus();
    };

    if (initial === 'create') {
      showCreate();
    } else if (initial === 'join') {
      showJoin();
    } else {
      showChoose();
    }
  });
}

function openInviteModal(server) {
  const link = `${location.origin}/invite/${server.inviteCode}`;
  openModal((card) => {
    const codeBox = el('code', { text: link });
    card.append(
      el('h2', { text: `Invite people to ${server.name}` }),
      el('p', { class: 'modal-sub', text: 'Anyone with this link can join — they can even hop in as a guest without creating an account.' }),
      el('div', { class: 'invite-link-box' },
        codeBox,
        el('button', {
          class: 'ghost-button small', type: 'button', text: 'Copy',
          onclick: async (event) => {
            await copyText(link);
            event.currentTarget.textContent = 'Copied!';
            setTimeout(() => { event.target && (event.target.textContent = 'Copy'); }, 1500);
          }
        })
      )
    );
    if (isModerator(server)) {
      card.append(el('div', { class: 'danger-zone' },
        el('button', {
          class: 'ghost-button small', type: 'button',
          onclick: async () => {
            try {
              const ack = await socket.request('regen-invite', { serverId: server.id });
              codeBox.textContent = `${location.origin}/invite/${ack.inviteCode}`;
              toast('Old invite links no longer work.');
            } catch (error) {
              toast(error.message, true);
            }
          }
        }, icon('i-refresh'), 'Reset invite link')
      ));
    }
  });
}

function openCreateChannelModal(server, initialKind) {
  openModal((card) => {
    card.append(el('h2', { text: 'Create channel' }), el('p', { class: 'modal-sub', text: `in ${server.name}` }));
    let kind = initialKind || 'text';
    const textChoice = el('button', { class: 'choice-card', type: 'button' }, icon('i-hash'), 'Text');
    const voiceChoice = el('button', { class: 'choice-card', type: 'button' }, icon('i-speaker'), 'Voice');
    const syncKind = () => {
      textChoice.classList.toggle('is-selected', kind === 'text');
      voiceChoice.classList.toggle('is-selected', kind === 'voice');
      nameInput.placeholder = kind === 'text' ? 'new-channel' : 'Game night';
    };
    textChoice.addEventListener('click', () => { kind = 'text'; syncKind(); });
    voiceChoice.addEventListener('click', () => { kind = 'voice'; syncKind(); });

    const nameInput = el('input', { type: 'text', maxlength: '32' });
    const topicInput = el('input', { type: 'text', maxlength: '250', placeholder: 'What is this channel about? (optional)' });
    const error = el('p', { class: 'form-error' });

    card.append(el('form', {
      class: 'modal-form',
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          const ack = await socket.request('create-channel', {
            serverId: server.id, kind, name: nameInput.value, topic: topicInput.value
          });
          closeModal();
          // The channel-added broadcast may not have landed yet; apply now.
          const fresh = getServer(server.id);
          if (fresh && !fresh.channels.some((candidate) => candidate.id === ack.channel.id)) {
            fresh.channels.push(ack.channel);
          }
          if (ack.channel.type === 'text') {
            openTextChannel(server.id, ack.channel.id);
          } else {
            openVoiceChannel(server.id, ack.channel.id);
          }
        } catch (requestError) {
          error.textContent = requestError.message;
        }
      }
    },
      el('div', { class: 'choice-row' }, textChoice, voiceChoice),
      el('label', {}, 'Channel name', nameInput),
      el('label', {}, 'Topic', topicInput),
      error,
      el('div', { class: 'modal-buttons' },
        el('button', { class: 'ghost-button', type: 'button', text: 'Cancel', onclick: closeModal }),
        el('button', { class: 'primary-button', type: 'submit', text: 'Create channel' })
      )
    ));
    syncKind();
    nameInput.focus();
  });
}

function openChannelSettings(server, channel) {
  openModal((card) => {
    const nameInput = el('input', { type: 'text', maxlength: '32', value: channel.name });
    const topicInput = el('input', { type: 'text', maxlength: '250', value: channel.topic || '' });
    const error = el('p', { class: 'form-error' });
    card.append(
      el('h2', { text: channel.type === 'text' ? `#${channel.name}` : channel.name }),
      el('p', { class: 'modal-sub', text: 'Channel settings' }),
      el('form', {
        class: 'modal-form',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            await socket.request('update-channel', {
              serverId: server.id, channelId: channel.id, name: nameInput.value, topic: topicInput.value
            });
            closeModal();
          } catch (requestError) {
            error.textContent = requestError.message;
          }
        }
      },
        el('label', {}, 'Name', nameInput),
        el('label', {}, 'Topic', topicInput),
        error,
        el('div', { class: 'modal-buttons' },
          el('button', { class: 'ghost-button', type: 'button', text: 'Cancel', onclick: closeModal }),
          el('button', { class: 'primary-button', type: 'submit', text: 'Save' })
        )
      ),
      el('div', { class: 'danger-zone' },
        el('button', {
          class: 'ghost-button danger', type: 'button',
          onclick: () => {
            confirmModal('Delete channel', `#${channel.name} and its full message history will be deleted for everyone.`, 'Delete channel', () => {
              socket.request('delete-channel', { serverId: server.id, channelId: channel.id })
                .catch((error2) => toast(error2.message, true));
            });
          }
        }, icon('i-trash'), 'Delete channel')
      )
    );
  });
}

function openServerSettings(server) {
  openModal((card) => {
    const nameInput = el('input', { type: 'text', maxlength: '50', value: server.name });
    const iconInput = el('input', { type: 'text', maxlength: '4', value: server.icon || '' });
    const error = el('p', { class: 'form-error' });

    card.append(
      el('h2', { text: 'Server settings' }),
      el('p', { class: 'modal-sub', text: server.name }),
      el('form', {
        class: 'modal-form',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            await socket.request('update-server', { serverId: server.id, name: nameInput.value, icon: iconInput.value });
            closeModal();
          } catch (requestError) {
            error.textContent = requestError.message;
          }
        }
      },
        el('label', {}, 'Server name', nameInput),
        el('label', {}, 'Icon (emoji)', iconInput),
        error,
        el('div', { class: 'modal-buttons' },
          el('button', { class: 'ghost-button', type: 'button', text: 'Cancel', onclick: closeModal }),
          el('button', { class: 'primary-button', type: 'submit', text: 'Save' })
        )
      )
    );

    const bans = server.bans || [];
    if (bans.length) {
      const list = el('div', { class: 'settings-list' });
      for (const bannedId of bans) {
        const user = getUser(bannedId);
        list.append(el('div', { class: 'settings-row' },
          el('span', { class: 'row-label' }, el('strong', { text: user.name }), el('small', { text: 'Banned' })),
          el('button', {
            class: 'ghost-button small', type: 'button', text: 'Unban',
            onclick: (event) => {
              socket.request('unban', { serverId: server.id, userId: bannedId })
                .then(() => event.target.closest('.settings-row').remove())
                .catch((error2) => toast(error2.message, true));
            }
          })
        ));
      }
      card.append(el('div', { class: 'danger-zone' }, el('p', { class: 'sidebar-label', text: 'Bans' }), list));
    }

    if (server.myRole === 'owner') {
      card.append(el('div', { class: 'danger-zone' },
        el('button', {
          class: 'ghost-button danger', type: 'button',
          onclick: () => confirmDeleteServer(server)
        }, icon('i-trash'), 'Delete server permanently')
      ));
    }
  });
}

function confirmDeleteServer(server) {
  confirmModal('Delete server', `${server.name}, every channel and the full message history will be deleted for everyone. This cannot be undone.`, 'Delete server', () => {
    socket.request('delete-server', { serverId: server.id }).catch((error) => toast(error.message, true));
  });
}

function applyMeUpdate(userView) {
  state.me = { ...state.me, ...userView };
  if (!('status' in userView)) {
    state.me.status = null; // publicUser omits status when there is none
  }
  const merged = { ...state.users.get(userView.id), ...userView };
  if (!('status' in userView)) {
    merged.status = null;
  }
  state.users.set(userView.id, merged);
  renderAll();
}

async function uploadAvatar(file, errorEl) {
  if (!/^image\/(png|jpeg)$/.test(file.type)) {
    const message = 'Avatars must be a static PNG or JPG image.';
    if (errorEl) { errorEl.textContent = message; } else { toast(message, true); }
    return null;
  }
  try {
    const safeName = file.type === 'image/png' ? 'avatar.png' : 'avatar.jpg';
    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        'X-File-Name': btoa(unescape(encodeURIComponent(safeName))),
        'Content-Type': 'application/octet-stream'
      },
      body: file
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Upload failed.');
    }
    const ack = await socket.request('profile', { avatar: data.attachment.url });
    applyMeUpdate(ack.user);
    toast('Avatar updated.');
    return ack.user.avatar;
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message; } else { toast(error.message, true); }
    return null;
  }
}

function pickAvatarFile() {
  const input = el('input', { type: 'file' });
  input.accept = 'image/png,image/jpeg';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (file) {
      uploadAvatar(file);
    }
  });
  input.click();
}

function statusLineText(status) {
  return `${status.emoji ? `${status.emoji} ` : ''}${status.text}`.trim();
}

function openMeMenu(anchor) {
  ui.popover.replaceChildren();
  const me = state.me;
  ui.popover.append(el('div', { class: 'popover-head profile-head' },
    avatarEl(me, 'pop-avatar'),
    el('span', { class: 'pop-name' },
      el('strong', {}, me.name, me.pronouns ? el('span', { class: 'pop-pronouns', text: me.pronouns }) : null),
      el('small', { text: me.guest ? 'Guest account' : `@${me.username}` })
    )
  ));
  if (me.status) {
    ui.popover.append(el('div', { class: 'pop-status', text: statusLineText(me.status) }));
  }
  ui.popover.append(el('button', {
    class: 'popover-item', type: 'button',
    onclick: () => { closePopovers(); openUserSettings('status'); }
  }, icon('i-emoji'), me.status ? 'Change status' : 'Set a status'));
  if (me.status) {
    ui.popover.append(el('button', {
      class: 'popover-item', type: 'button',
      onclick: async () => {
        closePopovers();
        try {
          const ack = await socket.request('status-set', { text: '', emoji: '' });
          applyMeUpdate(ack.user);
          toast('Status cleared.');
        } catch (error) {
          toast(error.message, true);
        }
      }
    }, icon('i-x'), 'Clear status'));
  }
  ui.popover.append(el('button', {
    class: 'popover-item', type: 'button',
    onclick: () => { closePopovers(); pickAvatarFile(); }
  }, icon('i-cam'), 'Change avatar'));
  ui.popover.append(el('button', {
    class: 'popover-item', type: 'button',
    onclick: () => { closePopovers(); openUserSettings('profile'); }
  }, icon('i-edit'), 'Edit profile'));
  positionFloating(ui.popover, anchor);
}

function openUserSettings(initialTab) {
  openModal((card) => {
    const tabs = { profile: 'Profile', status: 'Status', privacy: 'Privacy' };
    const error = el('p', { class: 'form-error' });
    const cancelBtn = () => el('button', { class: 'ghost-button', type: 'button', text: 'Cancel', onclick: closeModal });
    const saveBtn = (label) => el('button', { class: 'primary-button', type: 'submit', text: label });

    // ------------------------------------------------------- profile tab
    const nameInput = el('input', { type: 'text', maxlength: '40', value: state.me.name });
    const pronounInput = el('input', { type: 'text', maxlength: '32', value: state.me.pronouns || '', placeholder: 'e.g. they/them' });
    const bioInput = el('textarea', { maxlength: '190', rows: 3, placeholder: 'A short intro — markdown and emoji work here.' });
    bioInput.value = state.me.bio || '';
    const bioCount = el('small', { class: 'bio-counter', text: `${bioInput.value.length}/190` });
    bioInput.addEventListener('input', () => { bioCount.textContent = `${bioInput.value.length}/190`; });

    let selectedColor = state.me.color || 1;
    const swatches = el('div', { class: 'color-row' });
    for (let index = 1; index <= 8; index += 1) {
      const swatch = el('button', { class: `color-swatch avatar c${index}`, type: 'button', 'aria-label': `Color ${index}` });
      swatch.classList.toggle('is-selected', index === selectedColor);
      swatch.addEventListener('click', () => {
        selectedColor = index;
        for (const other of swatches.children) {
          other.classList.remove('is-selected');
        }
        swatch.classList.add('is-selected');
      });
      swatches.append(swatch);
    }

    const avatarFileInput = el('input', { type: 'file', hidden: true });
    avatarFileInput.accept = 'image/png,image/jpeg';
    avatarFileInput.addEventListener('change', async () => {
      const file = avatarFileInput.files && avatarFileInput.files[0];
      if (file) {
        const url = await uploadAvatar(file, error);
        if (url) {
          closeModal();
          openUserSettings('profile');
        }
      }
    });
    const avatarRow = el('div', { class: 'avatar-edit-row' },
      avatarEl(state.me, 'settings-avatar'),
      el('div', { class: 'avatar-edit-buttons' },
        el('button', { class: 'ghost-button small', type: 'button', onclick: () => avatarFileInput.click() }, icon('i-cam'), 'Change avatar'),
        state.me.avatar ? el('button', {
          class: 'ghost-button small danger', type: 'button',
          onclick: async () => {
            try {
              const ack = await socket.request('profile', { avatar: null });
              applyMeUpdate(ack.user);
              closeModal();
              openUserSettings('profile');
            } catch (requestError) {
              error.textContent = requestError.message;
            }
          }
        }, icon('i-trash'), 'Remove') : null
      )
    );

    const profilePanel = el('form', {
      class: 'modal-form',
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          const ack = await socket.request('profile', {
            displayName: nameInput.value,
            color: selectedColor,
            pronouns: pronounInput.value,
            bio: bioInput.value
          });
          state.me.bio = ack.bio;
          applyMeUpdate(ack.user);
          closeModal();
          toast('Profile saved.');
        } catch (requestError) {
          error.textContent = requestError.message;
        }
      }
    },
      avatarRow,
      avatarFileInput,
      el('label', {}, 'Display name', nameInput),
      state.me.guest ? null : el('p', { class: 'settings-hint', text: `Your @${state.me.username} handle never changes — it's how people find you and how you sign in.` }),
      el('label', {}, 'Pronouns', pronounInput),
      el('label', {}, el('span', { class: 'label-row' }, 'About me', bioCount), bioInput),
      el('label', {}, 'Avatar color (when no image)', swatches),
      el('div', { class: 'modal-buttons' }, cancelBtn(), saveBtn('Save profile'))
    );

    // -------------------------------------------------------- status tab
    const statusEmoji = el('input', { type: 'text', maxlength: '4', class: 'status-emoji-input', value: (state.me.status && state.me.status.emoji) || '', placeholder: '🙂' });
    const statusText = el('input', { type: 'text', maxlength: '64', value: (state.me.status && state.me.status.text) || '', placeholder: 'Studying, At work, BRB…' });
    const quick = el('div', { class: 'status-quick-row' });
    for (const emj of ['💬', '🎧', '📚', '💻', '☕', '🏃', '💤', '🎮']) {
      quick.append(el('button', { class: 'status-quick', type: 'button', text: emj, onclick: () => { statusEmoji.value = emj; } }));
    }
    const ttlSelect = el('select', { class: 'ttl-select' },
      el('option', { value: '0', text: 'Until I clear it' }),
      el('option', { value: String(3_600_000), text: 'For 1 hour' }),
      el('option', { value: String(86_400_000), text: 'For 24 hours' })
    );

    const statusPanel = el('form', {
      class: 'modal-form',
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          const ack = await socket.request('status-set', {
            text: statusText.value,
            emoji: statusEmoji.value,
            ttlMs: Number(ttlSelect.value)
          });
          applyMeUpdate(ack.user);
          closeModal();
          toast(ack.user.status ? 'Status set.' : 'Status cleared.');
        } catch (requestError) {
          error.textContent = requestError.message;
        }
      }
    },
      el('label', {}, 'Emoji', el('div', { class: 'status-emoji-line' }, statusEmoji, quick)),
      el('label', {}, 'Status message', statusText),
      el('label', {}, 'Clear after', ttlSelect),
      el('div', { class: 'modal-buttons' },
        state.me.status ? el('button', {
          class: 'ghost-button danger', type: 'button', text: 'Clear status',
          onclick: async () => {
            try {
              const ack = await socket.request('status-set', { text: '', emoji: '' });
              applyMeUpdate(ack.user);
              closeModal();
              toast('Status cleared.');
            } catch (requestError) {
              error.textContent = requestError.message;
            }
          }
        }) : cancelBtn(),
        saveBtn('Save status'))
    );

    // ------------------------------------------------------- privacy tab
    const PRIVACY_OPTIONS = [
      ['everyone', 'Everyone', 'Anyone you share a server or DM with can read your About me.'],
      ['small', 'Small servers & DMs', 'Only servers with 200 or fewer members, plus people you message.'],
      ['dms', 'Only people I message', 'Just your direct-message contacts can see the details.']
    ];
    let privacy = state.me.profilePrivacy || 'everyone';
    const privacyList = el('div', { class: 'privacy-list' });
    const rebuildPrivacy = () => {
      privacyList.replaceChildren();
      for (const [value, title, description] of PRIVACY_OPTIONS) {
        privacyList.append(el('button', {
          class: `privacy-option${privacy === value ? ' is-selected' : ''}`,
          type: 'button',
          onclick: () => { privacy = value; rebuildPrivacy(); }
        },
          el('strong', { text: title }),
          el('small', { text: description })
        ));
      }
    };
    rebuildPrivacy();

    const privacyPanel = el('form', {
      class: 'modal-form',
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          await socket.request('profile', { privacy });
          state.me.profilePrivacy = privacy;
          closeModal();
          toast('Privacy updated.');
        } catch (requestError) {
          error.textContent = requestError.message;
        }
      }
    },
      privacyList,
      el('p', { class: 'settings-hint', text: 'Your avatar, display name and username are always visible to everyone.' }),
      el('div', { class: 'modal-buttons' }, cancelBtn(), saveBtn('Save privacy'))
    );

    // ------------------------------------------------------ tab plumbing
    const panels = { profile: profilePanel, status: statusPanel, privacy: privacyPanel };
    const tabBar = el('div', { class: 'auth-tabs modal-tabs' });
    const tabButtons = {};
    const show = (key) => {
      for (const [k, btn] of Object.entries(tabButtons)) {
        btn.classList.toggle('is-active', k === key);
      }
      for (const [k, panel] of Object.entries(panels)) {
        panel.hidden = k !== key;
      }
      error.textContent = '';
    };
    for (const [key, label] of Object.entries(tabs)) {
      const btn = el('button', { type: 'button', text: label, onclick: () => show(key) });
      tabButtons[key] = btn;
      tabBar.append(btn);
    }

    card.append(
      el('h2', { text: 'Your profile' }),
      el('p', { class: 'modal-sub', text: state.me.guest ? 'Guest session — register to keep your identity across devices.' : `Signed in as @${state.me.username}` }),
      tabBar,
      profilePanel,
      statusPanel,
      privacyPanel,
      error,
      el('div', { class: 'danger-zone' },
        state.me.platformAdmin ? el('button', {
          class: 'ghost-button', type: 'button',
          onclick: () => window.open('/admin', '_blank')
        }, icon('i-shield'), 'Open admin console') : null,
        el('button', {
          class: 'ghost-button', type: 'button',
          onclick: async () => {
            await voice.leave().catch(() => {});
            await fetch('/api/logout', { method: 'POST' });
            location.reload();
          }
        }, icon('i-logout'), 'Log out')
      )
    );
    show(tabs[initialTab] ? initialTab : 'profile');
  });
}

function openFindUserModal() {
  openModal((card) => {
    const input = el('input', { type: 'text', maxlength: '24', placeholder: 'exact username' });
    const error = el('p', { class: 'form-error' });
    card.append(
      el('h2', { text: 'Find someone' }),
      el('p', { class: 'modal-sub', text: 'Start a direct message by exact username. You can also click any member in a server.' }),
      el('form', {
        class: 'modal-form',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            const found = await socket.request('find-user', { username: input.value.trim().replace(/^@/, '') });
            const ack = await socket.request('dm-open', { userId: found.user.id });
            state.users.set(ack.user.id, { ...state.users.get(ack.user.id), ...ack.user });
            if (ack.user.online) {
              state.online.add(ack.user.id);
            }
            state.dms.set(ack.dm.id, ack.dm);
            closeModal();
            openDm(ack.dm.id);
          } catch (requestError) {
            error.textContent = requestError.message;
          }
        }
      },
        el('label', {}, 'Username', input),
        error,
        el('div', { class: 'modal-buttons' },
          el('button', { class: 'primary-button', type: 'submit', text: 'Open conversation' })
        )
      )
    );
  });
}

// ============================================================== state sync

function bumpChannelActivity(channelKey, ts) {
  if (channelKey.startsWith('srv:')) {
    const [, serverId, channelId] = channelKey.split(':');
    const channel = getChannel(serverId, channelId);
    if (channel) {
      channel.lastAt = Math.max(channel.lastAt || 0, ts);
    }
  } else if (channelKey.startsWith('dm:')) {
    const dm = state.dms.get(channelKey.slice(3));
    if (dm) {
      dm.lastAt = Math.max(dm.lastAt || 0, ts);
    }
  }
}

function applyServerAdded(serverView, users) {
  state.servers.set(serverView.id, serverView);
  for (const [id, user] of Object.entries(users || {})) {
    state.users.set(id, { ...state.users.get(id), ...user });
    if (user.online) {
      state.online.add(id);
    }
  }
  renderAll();
}

function applyReady(snapshot) {
  state.me = snapshot.you;
  state.connId = snapshot.connId;
  state.lastRead = snapshot.you.lastRead || {};
  state.mentions = snapshot.mentions || {};
  state.voiceLimit = snapshot.voiceLimit || 12;
  state.guestTtlHours = snapshot.guestTtlHours || 24;

  state.servers.clear();
  for (const server of snapshot.servers || []) {
    state.servers.set(server.id, server);
  }
  state.dms.clear();
  for (const dm of snapshot.dms || []) {
    state.dms.set(dm.id, dm);
  }
  state.users.clear();
  for (const [id, user] of Object.entries(snapshot.users || {})) {
    state.users.set(id, user);
  }
  state.online = new Set(snapshot.online || []);
  state.voiceStates.clear();
  for (const [channelKey, participants] of Object.entries(snapshot.voice || {})) {
    state.voiceStates.set(channelKey, participants);
  }
  state.messages.clear();
  msgEls.clear();

  voice.iceServers = snapshot.iceServers || voice.iceServers;
  voice.resync(snapshot.connId);

  ui.connBanner.hidden = true;
  hideSplash();
  ui.authView.hidden = true;
  ui.appView.hidden = false;

  // Keep the current view when it still exists; otherwise land at home.
  const view = state.view;
  const stillValid =
    view.kind === 'home' ||
    (view.kind === 'dm' && state.dms.has(view.dmId)) ||
    ((view.kind === 'text' || view.kind === 'voice') && getChannel(view.serverId, view.channelId));
  if (!stillValid) {
    state.view = { kind: 'home' };
  }

  renderAll();
  if (view.kind === 'text' || view.kind === 'dm') {
    if (stillValid) {
      openChat(activeChannelKey());
    }
  }

  if (state.pendingInvite) {
    const code = state.pendingInvite;
    state.pendingInvite = null;
    socket.request('join-invite', { code })
      .then((ack) => {
        applyServerAdded(ack.server, ack.users);
        openServer(ack.server.id);
        toast(`Welcome to ${ack.server.name}!`);
      })
      .catch((error) => toast(error.message, true));
    history.replaceState({}, '', '/');
  }
  state.booted = true;
}

function wireSocketEvents() {
  socket.on('ready', applyReady);

  socket.on('socket-closed', () => {
    if (state.booted) {
      ui.connBanner.hidden = false;
    }
  });

  socket.on('message', ({ channelKey, message, user }) => {
    if (user) {
      state.users.set(user.id, { ...state.users.get(user.id), ...user });
    }
    insertMessage(channelKey, message);
    bumpChannelActivity(channelKey, message.createdAt);

    const viewing = activeChannelKey() === channelKey && document.hasFocus() && nearBottom();
    if (!viewing) {
      const mentioned = Array.isArray(message.mentions) && message.mentions.includes(state.me.id);
      const isDm = channelKey.startsWith('dm:');
      if (mentioned || isDm) {
        state.mentions[channelKey] = (state.mentions[channelKey] || 0) + 1;
      }
    }
    const entries = state.typing.get(channelKey);
    if (entries) {
      entries.delete(message.authorId);
      renderTyping();
    }
    renderSidebar();
    renderRail();
    updateTitle();
  });

  socket.on('message-updated', ({ channelKey, message }) => {
    applyMessageUpdate(channelKey, message);
  });

  socket.on('typing', ({ channelKey, userId }) => {
    let entries = state.typing.get(channelKey);
    if (!entries) {
      entries = new Map();
      state.typing.set(channelKey, entries);
    }
    entries.set(userId, Date.now() + 4000);
    if (activeChannelKey() === channelKey) {
      renderTyping();
    }
  });

  socket.on('read', ({ channelKey, ts }) => {
    state.lastRead[channelKey] = Math.max(state.lastRead[channelKey] || 0, ts);
    delete state.mentions[channelKey];
    renderSidebar();
    renderRail();
    updateTitle();
  });

  socket.on('presence', ({ userId, online }) => {
    if (online) {
      state.online.add(userId);
    } else {
      state.online.delete(userId);
    }
    renderSidebar();
    renderMembers();
  });

  socket.on('user-updated', ({ user }) => {
    const merged = { ...state.users.get(user.id), ...user };
    if (!('status' in user)) {
      merged.status = null; // an omitted status means "no active status"
    }
    state.users.set(user.id, merged);
    if (user.id === state.me.id) {
      state.me = { ...state.me, ...user };
      if (!('status' in user)) {
        state.me.status = null;
      }
      renderMeBar();
    }
    renderSidebar();
    renderMembers();
  });

  socket.on('server-added', ({ server, users }) => {
    applyServerAdded(server, users);
  });

  socket.on('server-updated', ({ server }) => {
    state.servers.set(server.id, server);
    renderAll();
  });

  socket.on('server-removed', ({ serverId, reason }) => {
    const server = state.servers.get(serverId);
    state.servers.delete(serverId);
    if ((state.view.kind === 'text' || state.view.kind === 'voice') && state.view.serverId === serverId) {
      state.view = { kind: 'home' };
    }
    if (voice.active && voice.channelKey && voice.channelKey.startsWith(`srv:${serverId}:`)) {
      voice.leave({ notifyServer: false });
    }
    if (reason === 'kicked' && server) {
      toast(`You were kicked from ${server.name}.`, true);
    } else if (reason === 'banned' && server) {
      toast(`You were banned from ${server.name}.`, true);
    } else if (reason === 'expired') {
      toast(`The temporary server "${(server && server.name) || 'server'}" has closed.`);
    }
    renderAll();
  });

  socket.on('member-joined', ({ serverId, member, user, online }) => {
    const server = state.servers.get(serverId);
    if (user) {
      state.users.set(user.id, { ...state.users.get(user.id), ...user });
      if (online) {
        state.online.add(user.id);
      }
    }
    if (server && !server.members.some((candidate) => candidate.userId === member.userId)) {
      server.members.push(member);
    }
    renderSidebar();
    renderMembers();
  });

  socket.on('member-left', ({ serverId, userId }) => {
    const server = state.servers.get(serverId);
    if (server) {
      server.members = server.members.filter((member) => member.userId !== userId);
    }
    renderSidebar();
    renderMembers();
  });

  socket.on('member-updated', ({ serverId, userId, role }) => {
    const server = state.servers.get(serverId);
    if (server) {
      const member = server.members.find((candidate) => candidate.userId === userId);
      if (member) {
        member.role = role;
      }
      if (userId === state.me.id) {
        server.myRole = role;
        toast(role === 'admin' ? `You are now an admin in ${server.name}.` : `You are no longer an admin in ${server.name}.`);
      }
    }
    renderAll();
  });

  socket.on('channel-added', ({ serverId, channel }) => {
    const server = state.servers.get(serverId);
    if (server && !server.channels.some((candidate) => candidate.id === channel.id)) {
      server.channels.push(channel);
    }
    renderSidebar();
  });

  socket.on('channel-updated', ({ serverId, channel }) => {
    const server = state.servers.get(serverId);
    if (server) {
      const index = server.channels.findIndex((candidate) => candidate.id === channel.id);
      if (index >= 0) {
        server.channels[index] = channel;
      }
    }
    renderSidebar();
    renderMainView();
  });

  socket.on('channel-removed', ({ serverId, channelId }) => {
    const server = state.servers.get(serverId);
    if (server) {
      server.channels = server.channels.filter((channel) => channel.id !== channelId);
    }
    state.messages.delete(keyForText(serverId, channelId));
    if ((state.view.kind === 'text' || state.view.kind === 'voice') &&
        state.view.serverId === serverId && state.view.channelId === channelId) {
      openServer(serverId);
      return;
    }
    renderSidebar();
  });

  socket.on('dm-added', ({ dm, user }) => {
    state.dms.set(dm.id, dm);
    if (user) {
      state.users.set(user.id, { ...state.users.get(user.id), ...user });
      if (user.online) {
        state.online.add(user.id);
      }
    }
    renderSidebar();
    renderRail();
  });

  socket.on('voice-state', ({ channelKey, participants }) => {
    const before = state.voiceStates.get(channelKey) || [];
    state.voiceStates.set(channelKey, participants);
    if (!participants.length) {
      state.voiceStates.delete(channelKey);
    }

    if (voice.active && voice.channelKey === channelKey) {
      voice.syncPeers(participants);
      if (participants.length > before.length) {
        beep('join');
      } else if (participants.length < before.length) {
        beep('leave');
      }
    }
    renderSidebar();
    renderVoiceView();
  });

  socket.on('voice-kicked', () => {
    voice.leave({ notifyServer: false });
    toast('The voice channel was closed.');
  });

  socket.on('signal', (message) => {
    voice.handleSignal(message);
  });
}

// ============================================================== auth flow

let splashHidden = false;
function hideSplash() {
  if (splashHidden) {
    return;
  }
  splashHidden = true;
  const splash = document.getElementById('splashView');
  if (!splash) {
    return;
  }
  // Give the splash a short beat so it reads as an intro, not a flash.
  setTimeout(() => {
    splash.classList.add('is-done');
    setTimeout(() => splash.remove(), 620);
  }, 320);
}

function showAuth() {
  hideSplash();
  ui.authView.hidden = false;
  ui.appView.hidden = true;
  ui.authInviteNote.hidden = !state.pendingInvite;
  try {
    const saved = localStorage.getItem('roomly-name');
    if (saved && !$('#guestName').value) {
      $('#guestName').value = saved;
    }
  } catch {}
}

async function submitAuth(endpoint, payload, errorEl) {
  errorEl.textContent = '';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Something went wrong.');
    }
    try {
      localStorage.setItem('roomly-name', data.user.name);
    } catch {}
    socket.connect();
  } catch (error) {
    errorEl.textContent = error.message;
  }
}

function wireAuthForms() {
  const tabs = document.querySelectorAll('.auth-tabs button');
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const other of tabs) {
        other.classList.toggle('is-active', other === tab);
      }
      for (const panel of document.querySelectorAll('.auth-form')) {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      }
    });
  }

  $('#loginForm').addEventListener('submit', (event) => {
    event.preventDefault();
    submitAuth('/api/login', {
      username: $('#loginUsername').value.trim(),
      password: $('#loginPassword').value
    }, $('#loginError'));
  });

  $('#registerForm').addEventListener('submit', (event) => {
    event.preventDefault();
    submitAuth('/api/register', {
      username: $('#regUsername').value.trim(),
      displayName: $('#regDisplayName').value.trim(),
      password: $('#regPassword').value
    }, $('#regError'));
  });

  $('#guestForm').addEventListener('submit', (event) => {
    event.preventDefault();
    submitAuth('/api/guest', { displayName: $('#guestName').value.trim() }, $('#guestError'));
  });
}

// ============================================================== wiring

function wireUi() {
  ui.homeButton.addEventListener('click', openHome);
  ui.backButton.addEventListener('click', () => {
    state.mobilePane = 'nav';
    applyMobileLayout();
  });
  ui.mnavHome.addEventListener('click', openHome);
  ui.mnavChats.addEventListener('click', () => {
    state.mobilePane = 'nav';
    applyMobileLayout();
  });
  ui.mnavMe.addEventListener('click', openUserSettings);
  mobileQuery.addEventListener('change', () => {
    if (isMobile()) {
      state.memberPanelOpen = false; // full-screen overlay: opt-in on phones
    }
    if (state.me) {
      renderAll();
    } else {
      applyMobileLayout();
    }
  });
  ui.addServerButton.addEventListener('click', () => openAddServerModal());
  ui.homeCreateServer.addEventListener('click', () => openAddServerModal('create'));
  ui.homeJoinServer.addEventListener('click', () => openAddServerModal('join'));
  ui.findUserButton.addEventListener('click', openFindUserModal);
  ui.settingsButton.addEventListener('click', () => openUserSettings('profile'));
  ui.meAvatar.style.cursor = 'pointer';
  ui.meAvatar.setAttribute('role', 'button');
  ui.meAvatar.setAttribute('tabindex', '0');
  ui.meAvatar.setAttribute('aria-label', 'Profile menu');
  ui.meAvatar.addEventListener('click', () => openMeMenu(ui.meAvatar));
  ui.meAvatar.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMeMenu(ui.meAvatar);
    }
  });
  ui.serverMenuButton.addEventListener('click', (event) => openServerMenu(event.currentTarget));
  ui.invitePeopleButton.addEventListener('click', () => {
    const server = currentServerForView();
    if (server) {
      openInviteModal(server);
    }
  });
  ui.toggleMembersButton.addEventListener('click', () => {
    state.memberPanelOpen = !state.memberPanelOpen;
    ui.toggleMembersButton.setAttribute('aria-pressed', String(state.memberPanelOpen));
    renderMainView();
  });
  ui.addTextChannelButton.addEventListener('click', () => {
    const server = currentServerForView();
    if (server) {
      openCreateChannelModal(server, 'text');
    }
  });
  ui.addVoiceChannelButton.addEventListener('click', () => {
    const server = currentServerForView();
    if (server) {
      openCreateChannelModal(server, 'voice');
    }
  });

  // Composer
  ui.sendButton.addEventListener('click', sendCurrentMessage);
  ui.composerInput.addEventListener('input', () => {
    autoSizeComposer();
    updateMentionPopup();
    const now = Date.now();
    if (now - lastTypingSentAt > 2500 && ui.composerInput.value.trim() && !state.editingId) {
      lastTypingSentAt = now;
      const channelKey = activeChannelKey();
      if (channelKey && CHATTY_KINDS.has(state.view.kind)) {
        socket.push('typing', { channelKey });
      }
    }
  });
  ui.composerInput.addEventListener('keydown', (event) => {
    if (mentionState.open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        mentionState.highlighted = (mentionState.highlighted + delta + mentionState.matches.length) % mentionState.matches.length;
        updateMentionPopup();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pickMention(mentionState.highlighted);
        return;
      }
      if (event.key === 'Escape') {
        closeMentionPopup();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendCurrentMessage();
    } else if (event.key === 'Escape') {
      if (state.editingId) {
        stopEditing();
      } else if (state.replyTo) {
        cancelReply();
      }
    } else if (event.key === 'ArrowUp' && !ui.composerInput.value) {
      const channelKey = activeChannelKey();
      const bucket = channelKey ? state.messages.get(channelKey) : null;
      if (bucket) {
        const mine = [...bucket.list].reverse().find((message) => message.authorId === state.me.id && !message.deleted);
        if (mine) {
          event.preventDefault();
          startEditing(mine);
        }
      }
    }
  });
  ui.replyBarCancel.addEventListener('click', () => {
    if (state.editingId) {
      stopEditing();
    } else {
      cancelReply();
    }
  });
  ui.emojiButton.addEventListener('click', (event) => {
    openEmojiPopup(event.currentTarget, (emoji) => {
      const input = ui.composerInput;
      const caret = input.selectionStart || input.value.length;
      input.value = input.value.slice(0, caret) + emoji + input.value.slice(caret);
      input.focus();
      input.setSelectionRange(caret + emoji.length, caret + emoji.length);
      autoSizeComposer();
    });
  });
  ui.voiceChatButton.addEventListener('click', () => {
    state.voiceChatOpen = !state.voiceChatOpen;
    renderMainView();
    if (state.voiceChatOpen) {
      openChat(activeChannelKey());
    }
  });
  ui.voiceMsgButton.addEventListener('click', () => {
    if (rec.recorder) {
      stopVoiceRecording(false);
    } else {
      startVoiceRecording();
    }
  });
  ui.recSend.addEventListener('click', () => stopVoiceRecording(false));
  ui.recCancel.addEventListener('click', () => stopVoiceRecording(true));
  ui.attachButton.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', () => {
    uploadFiles(Array.from(ui.fileInput.files || []));
    ui.fileInput.value = '';
  });
  ui.composerInput.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData.files || []);
    if (files.length) {
      event.preventDefault();
      uploadFiles(files);
    }
  });
  ui.chatView.addEventListener('dragover', (event) => event.preventDefault());
  ui.chatView.addEventListener('drop', (event) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) {
      uploadFiles(files);
    }
  });

  ui.loadOlderButton.addEventListener('click', loadOlder);
  ui.messageScroll.addEventListener('scroll', debounce(() => {
    if (nearBottom() && document.hasFocus()) {
      const channelKey = activeChannelKey();
      if (channelKey && CHATTY_KINDS.has(state.view.kind)) {
        const bucket = state.messages.get(channelKey);
        const last = bucket && bucket.list[bucket.list.length - 1];
        if (last && isUnread(channelKey, last.createdAt)) {
          markRead(channelKey);
        }
      }
    }
  }, 300));

  // Voice controls
  ui.voiceJoinButton.addEventListener('click', () => joinVoice(true));
  ui.voiceJoinMicButton.addEventListener('click', () => joinVoice(false));
  const toggleMic = () => voice.toggleMic().catch((error) => toast(error.message, true));
  const toggleCam = () => voice.toggleCam().catch((error) => toast(error.message, true));
  const toggleScreenShare = () => {
    if (voice.screenStream) {
      voice.stopScreen();
      toast('Screen sharing stopped.');
    } else {
      voice.startScreen().catch((error) => {
        if (error && error.name !== 'NotAllowedError') {
          toast('Screen sharing failed to start.', true);
        }
      });
    }
  };
  const stopShare = () => {
    if (voice.screenStream) {
      voice.stopScreen();
      toast('Screen sharing stopped.');
    }
  };
  ui.vMicButton.addEventListener('click', toggleMic);
  ui.vCamButton.addEventListener('click', toggleCam);
  ui.vScreenButton.addEventListener('click', toggleScreenShare);
  ui.dockMicButton.addEventListener('click', toggleMic);
  ui.dockCamButton.addEventListener('click', toggleCam);
  ui.dockScreenButton.addEventListener('click', toggleScreenShare);
  ui.screenSelfStop.addEventListener('click', stopShare);
  ui.sharePill.addEventListener('click', stopShare);
  ui.unpinButton.addEventListener('click', () => togglePin(state.pinned));
  ui.vLeaveButton.addEventListener('click', () => {
    voice.leave();
    beep('leave');
  });
  ui.voiceDockLeave.addEventListener('click', () => {
    voice.leave();
    beep('leave');
  });
  ui.screenStage.addEventListener('dblclick', () => {
    // Fullscreen the whole stage (share + tiles + controls), never just the
    // video — the mic/camera/stop controls must stay reachable.
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (ui.voiceStage.requestFullscreen) {
      ui.voiceStage.requestFullscreen().catch(() => {});
    }
  });

  // Overlays
  ui.modalRoot.querySelector('.modal-backdrop').addEventListener('click', closeModal);
  ui.lightbox.addEventListener('click', () => {
    ui.lightbox.hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!ui.lightbox.hidden) {
        ui.lightbox.hidden = true;
      } else if (!ui.modalRoot.hidden) {
        closeModal();
      } else {
        const popoverWasOpen = !ui.popover.hidden || !ui.emojiPopup.hidden || mentionState.open;
        closePopovers();
        if (!popoverWasOpen && state.pinned) {
          togglePin(state.pinned);
        }
      }
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!ui.popover.hidden && !ui.popover.contains(event.target)) {
      ui.popover.hidden = true;
    }
    if (!ui.emojiPopup.hidden && !ui.emojiPopup.contains(event.target) && event.target !== ui.emojiButton) {
      ui.emojiPopup.hidden = true;
    }
    if (mentionState.open && !ui.mentionPopup.contains(event.target) && event.target !== ui.composerInput) {
      closeMentionPopup();
    }
  });

  window.addEventListener('focus', () => {
    const channelKey = activeChannelKey();
    if (channelKey && CHATTY_KINDS.has(state.view.kind) && nearBottom() && !ui.chatView.hidden) {
      markRead(channelKey);
    }
  });

  window.addEventListener('beforeunload', () => {
    socket.push('voice-leave');
  });
}

// ============================================================== boot

function initFx() {
  try {
    fx.aurora(ui.authView, { intensity: 1, blobs: 6 });
    fx.aurora(ui.homeView, { intensity: 0.55, blobs: 5 });
    fx.aurora(ui.voiceView, { intensity: 0.4, blobs: 4 });
    fx.tilt(ui.homeServerCards, '.home-card-item');
    fx.speakingGlow({
      getAnalysers: () => voice.analysers,
      getTarget: (key) => {
        const tile = voiceTileEls.get(key === 'self' ? 'self' : key);
        if (state.pinned && (state.pinned === key || (key === 'self' && state.pinned === 'self'))) {
          return ui.screenStage;
        }
        return tile || null;
      }
    });
  } catch {}
}

async function boot() {
  state.memberPanelOpen = !isMobile();
  initFx();
  const inviteMatch = location.pathname.match(/^\/invite\/([a-z0-9]+)/i);
  if (inviteMatch) {
    state.pendingInvite = inviteMatch[1].toLowerCase();
  }

  wireAuthForms();
  wireUi();
  wireSocketEvents();

  try {
    const response = await fetch('/api/me');
    if (response.ok) {
      socket.connect();
      return;
    }
  } catch {}
  showAuth();
}

boot();

// Debug handle for tests and support diagnostics (read-only usage expected).
window.roomlyDebug = { state, voice, socket };
