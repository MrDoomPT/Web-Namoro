const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const db = new sqlite3.Database('./webnamoro.db', (err) => {
    if (err) console.error('Erro ao abrir a BD', err.message);
    else console.log('Base de dados ligada com sucesso!');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT,
        avatar TEXT,
        role TEXT DEFAULT 'user',
        banned INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        recipient TEXT,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        reactions TEXT DEFAULT '{}'
    )`);

    // Dono automático: Lemos / DrLemos
    db.get(`SELECT * FROM users WHERE username = 'Lemos'`, (err, row) => {
        if (!row) {
            db.run(`INSERT INTO users (username, password, avatar, role, banned) VALUES ('Lemos', 'DrLemos', 'https://api.dicebear.com/7.x/bottts/svg?seed=Lemos', 'owner', 0)`);
        }
    });

    // Registar a Bot Mel na BD como sistema/bot
    db.get(`SELECT * FROM users WHERE username = 'Mel 🤖'`, (err, row) => {
        if (!row) {
            db.run(`INSERT INTO users (username, password, avatar, role, banned) VALUES ('Mel 🤖', 'botpass', 'https://api.dicebear.com/7.x/bottts/svg?seed=Mel', 'bot', 0)`);
        }
    });

    const cleanOldMessages = () => {
        db.run(`DELETE FROM messages WHERE timestamp < datetime('now', '-2 days')`, (err) => {
            if (!err) console.log('🧹 Limpeza automática: Mensagens com mais de 2 dias removidas.');
        });
    };
    cleanOldMessages();
    setInterval(cleanOldMessages, 1000 * 60 * 60);
});

const userMessageTimes = {};
const userKickCounts = {}; // Registo de kicks por flood para ban automático

io.on('connection', (socket) => {
    console.log('Utilizador conectado:', socket.id);

    socket.on('get_history', ({ username, recipient }) => {
        if (recipient) {
            db.all(`SELECT * FROM messages WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?) ORDER BY timestamp ASC LIMIT 100`, 
                [username, recipient, recipient, username], (err, rows) => {
                if (!err) socket.emit('chat_history', rows);
            });
        } else {
            db.all(`SELECT * FROM messages WHERE recipient IS NULL ORDER BY timestamp ASC LIMIT 100`, [], (err, rows) => {
                if (!err) socket.emit('chat_history', rows);
            });
        }
        updateOnlineUsers();
    });

    socket.on('auth', ({ username, password, avatar }, callback) => {
        if (!username || !password) return callback({ success: false, message: 'Preencha todos os campos.' });
        if (username === 'Mel 🤖') return callback({ success: false, message: 'Nome reservado para a Bot Mel.' });
        
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
            if (user) {
                if (user.banned) {
                    return callback({ success: false, message: '🚫 Você está banido deste servidor!' });
                }
                if (user.password === password) {
                    socket.username = username;
                    socket.role = user.role;
                    updateOnlineUsers();
                    callback({ success: true, user: { username, role: user.role, avatar: user.avatar } });

                    // Mensagem de Boas-Vindas da Mel
                    sendBotWelcome(username);
                } else {
                    callback({ success: false, message: 'Senha incorreta!' });
                }
            } else {
                const defaultAvatar = avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`;
                const role = (username === 'Lemos') ? 'owner' : 'user';
                db.run(`INSERT INTO users (username, password, avatar, role, banned) VALUES (?, ?, ?, ?, 0)`, [username, password, defaultAvatar, role], (err) => {
                    if (err) {
                        callback({ success: false, message: 'Nome de utilizador já registado.' });
                    } else {
                        socket.username = username;
                        socket.role = role;
                        updateOnlineUsers();
                        callback({ success: true, user: { username, role, avatar: defaultAvatar } });

                        // Mensagem de Boas-Vindas da Mel para novo registo
                        sendBotWelcome(username);
                    }
                });
            }
        });
    });

    // Função auxiliar para a Mel dar boas-vindas limpando as antigas mensagens dela
    function sendBotWelcome(newUsername) {
        // Apagar mensagens anteriores da Mel para manter o chat limpo
        db.run(`DELETE FROM messages WHERE sender = 'Mel 🤖' AND recipient IS NULL`, () => {
            const welcomeText = `💖 Olá @${newUsername}! Bem-vindo(a) ao Web Namoro. Divirtam-se com respeito e evitem flood/links!`;
            db.run(`INSERT INTO messages (sender, recipient, content, reactions) VALUES ('Mel 🤖', NULL, ?, '{}')`, [welcomeText], function(err) {
                if (!err) {
                    io.emit('message', {
                        id: this.lastID,
                        sender: 'Mel 🤖',
                        recipient: null,
                        content: welcomeText,
                        timestamp: new Date().toISOString(),
                        reactions: '{}'
                    });
                }
            });
        });
    }

    // Envio de mensagens + Regras da Mel (Anti-Flood, Anti-Link)
    socket.on('send_message', ({ recipient, content }) => {
        if (!socket.username) return;

        // Regra Anti-Link (Extremamente Proibido)
        const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9][-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b)/gi;
        if (!recipient && linkRegex.test(content) && socket.role !== 'owner' && socket.role !== 'admin') {
            triggerMelPunishment(socket, 'divulgar links (proibido)');
            return;
        }

        // Regra Anti-Flood (Mais de 3 msgs em 5 segundos)
        const now = Date.now();
        if (!userMessageTimes[socket.username]) userMessageTimes[socket.username] = [];
        userMessageTimes[socket.username] = userMessageTimes[socket.username].filter(t => now - t < 5000);
        
        if (!recipient && userMessageTimes[socket.username].length >= 3) {
            triggerMelPunishment(socket, 'floopar o chat');
            return;
        }
        userMessageTimes[socket.username].push(now);

        // Guardar e enviar mensagem normal
        db.run(`INSERT INTO messages (sender, recipient, content, reactions) VALUES (?, ?, ?, ?)`, 
            [socket.username, recipient || null, content, '{}'], function(err) {
            if (!err) {
                const msgObj = {
                    id: this.lastID,
                    sender: socket.username,
                    recipient: recipient || null,
                    content,
                    timestamp: new Date().toISOString(),
                    reactions: '{}'
                };

                if (recipient) {
                    socket.emit('message', msgObj);
                    for (let [id, s] of io.of('/').sockets) {
                        if (s.username === recipient) {
                            s.emit('message', msgObj);
                            s.emit('private_notification', { sender: socket.username });
                        }
                    }
                } else {
                    io.emit('message', msgObj);
                }
            }
        });
    });

    // Sistema de Punição automático da Mel (Kick por Flood/Links e Ban se atingir 3 kicks)
    function triggerMelPunishment(socketTarget, motivo) {
        const username = socketTarget.username;
        if (!userKickCounts[username]) userKickCounts[username] = 0;
        userKickCounts[username]++;

        const kicksAtuais = userKickCounts[username];

        if (kicksAtuais >= 3) {
            // Ban definitivo após 3 kicks
            db.run(`UPDATE users SET banned = 1 WHERE username = ?`, [username], () => {
                const banMsg = `🔨 A Mel baniu @${username} permanentemente por reincidência de infrações (${motivo})!`;
                io.emit('system_message', banMsg);
                socketTarget.emit('kicked', 'Você foi BANIDO permanentemente por atingir o limite de infrações!');
                socketTarget.disconnect();
                delete userKickCounts[username];
            });
        } else {
            // Apenas Kick e aviso da Mel
            const kickMsg = `⚠️ A Mel kikou @${username} por ${motivo}! (Aviso ${kicksAtuais}/3 antes do ban).`;
            io.emit('system_message', kickMsg);
            socketTarget.emit('kicked', `Você foi kikado pela Mel por ${motivo}! (${kicksAtuais}/3 avisos).`);
            socketTarget.disconnect();
        }
    }

    socket.on('react_message', ({ messageId, emoji, recipient }) => {
        db.get(`SELECT reactions FROM messages WHERE id = ?`, [messageId], (err, row) => {
            if (row) {
                let reactions = {};
                try { reactions = JSON.parse(row.reactions); } catch(e){}
                
                if (!reactions[emoji]) reactions[emoji] = [];
                const idx = reactions[emoji].indexOf(socket.username);
                if (idx > -1) {
                    reactions[emoji].splice(idx, 1);
                    if (reactions[emoji].length === 0) delete reactions[emoji];
                } else {
                    reactions[emoji].push(socket.username);
                }

                db.run(`UPDATE messages SET reactions = ? WHERE id = ?`, [JSON.stringify(reactions), messageId], () => {
                    if (recipient) {
                        for (let [id, s] of io.of('/').sockets) {
                            if (s.username === socket.username || s.username === recipient) {
                                s.emit('update_reactions', { messageId, reactions });
                            }
                        }
                    } else {
                        io.emit('update_reactions', { messageId, reactions });
                    }
                });
            }
        });
    });

    socket.on('kick_user', ({ targetUser }) => {
        if (socket.role !== 'owner' && socket.role !== 'admin') return;
        db.get(`SELECT role FROM users WHERE username = ?`, [targetUser], (err, row) => {
            if (row) {
                if (socket.role === 'admin' && (row.role === 'owner' || row.role === 'admin')) return;
                for (let [id, s] of io.of('/').sockets) {
                    if (s.username === targetUser) {
                        s.emit('kicked', 'Você foi expulso do chat.');
                        s.disconnect();
                    }
                }
                io.emit('system_message', `🚨 @${targetUser} foi expulso por @${socket.username}.`);
            }
        });
    });

    socket.on('ban_user', ({ targetUser }) => {
        if (socket.role !== 'owner' && socket.role !== 'admin') return;
        db.get(`SELECT role FROM users WHERE username = ?`, [targetUser], (err, row) => {
            if (row) {
                if (socket.role === 'admin' && (row.role === 'owner' || row.role === 'admin')) return;
                db.run(`UPDATE users SET banned = 1 WHERE username = ?`, [targetUser], () => {
                    for (let [id, s] of io.of('/').sockets) {
                        if (s.username === targetUser) {
                            s.emit('kicked', 'Você foi BANIDO deste servidor!');
                            s.disconnect();
                        }
                    }
                    io.emit('system_message', `🔨 @${targetUser} foi BANIDO por @${socket.username}!`);
                    updateOnlineUsers();
                });
            }
        });
    });

    socket.on('set_admin', ({ targetUser }) => {
        if (socket.role !== 'owner') return;
        db.run(`UPDATE users SET role = 'admin' WHERE username = ?`, [targetUser], () => {
            io.emit('system_message', `⭐ @${targetUser} foi promovido a Administrador por @${socket.username}!`);
            updateOnlineUsers();
        });
    });

    socket.on('demote_admin', ({ targetUser }) => {
        if (socket.role !== 'owner') return;
        db.run(`UPDATE users SET role = 'user' WHERE username = ?`, [targetUser], () => {
            io.emit('system_message', `📉 @${targetUser} foi despromovido a Membro por @${socket.username}.`);
            updateOnlineUsers();
        });
    });

    socket.on('disconnect', () => {
        updateOnlineUsers();
    });
});

function updateOnlineUsers() {
    const onlineUsers = [];
    
    // Garantir que a Mel aparece sempre na lista de online
    onlineUsers.push({ username: 'Mel 🤖', role: 'bot' });

    for (let [id, s] of io.of('/').sockets) {
        if (s.username && s.username !== 'Mel 🤖') {
            onlineUsers.push({ username: s.username, role: s.role || 'user' });
        }
    }
    io.emit('online_users', onlineUsers);
}

server.listen(3000, () => {
    console.log('💖 Servidor Web Namoro a correr em http://localhost:3000');
});
