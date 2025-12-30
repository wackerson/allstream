import express from 'express' 
import cors from 'cors'
import fetch from 'node-fetch'
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as http from 'http';
import { MongoClient } from 'mongodb';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const DEFAULT_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
};

const fetchWithHeaders = (url, options = {}) => {
  return fetch(url, {
    method: 'GET',
    ...options,
    headers: {
      ...DEFAULT_FETCH_HEADERS,
      ...(options.headers || {})
    }
  });
};



// Create a map to store chat messages for each stream
const chatRooms = {}; // Each source/id combination will be a unique room

// Add a map to track viewer counts for each room
const roomViewers = {};

// Add a map to track pinned messages for each room
const pinnedMessages = {};

// Function to normalize room IDs to ensure consistency
function normalizeRoomId(room) {
    // Extract source and id from the room string (typically formatted as "source-id")
    const parts = room.split('-');
    if (parts.length >= 2) {
        const source = parts[0];
        const id = parts.slice(1).join('-'); // Join the rest in case id contains hyphens
        return `${source}-${id}`;
    }
    return room; // Return original if not matching expected format
}

// Function to update viewer count and broadcast it to all clients in the room
function updateViewerCount(room) {
    // Normalize the room ID
    const normalizedRoom = normalizeRoomId(room);
    
    // Get the clients in the room
    const clients = io.sockets.adapter.rooms.get(normalizedRoom);
    // Count the clients (if room exists)
    const count = clients ? clients.size : 0;
    
    // Store the count
    roomViewers[normalizedRoom] = count;
    
    // Broadcast the updated count to all clients in the room
    io.in(normalizedRoom).emit('viewer count', { count });
    
    console.log(`Updated viewer count for room ${normalizedRoom}: ${count} viewers`);
    return count;
}

// Add this banned words list near the top of the file after the const chatRooms = {}; line
const bannedWords = [
    // Racial slurs
    'n1gger', 'n1gga', 'nigger', 'nigga', 'ni gga', 'n igga', 'chink', 'gook', 'spic', 'kike', 'wetback', 'towelhead',
    // Hate speech
    'faggot', 'fag', 'dyke', 'tranny', 'retard', 'retarded',
    // Severe profanity
    'cunt', 'n i g g a', 'n 1 g g a', 'nig', 'niggers'
];

// Add banned IPs set to track banned users
const bannedIPs = new Set();

// Track usernames and their associated IPs
const userIPMap = new Map();

// Track banned IPs with their associated usernames
const bannedIPsWithUsernames = new Map(); // IP → username

// Admin authentication code
const ADMIN_CODE = '1221';
const adminSockets = new Set();

// Function to check if a message contains banned words
function containsBannedWords(message) {
    const lowerMessage = message.toLowerCase();
    
    // URL detection patterns
    const urlPatterns = [
        // Match http/https URLs
        /(https?:\/\/[^\s]+)/gi,
        // Match www. style URLs
        /(www\.[^\s]+)/gi,
        // Match common domain extensions
        /([a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,})/gi,
        // Match IP addresses
        /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g
    ];
    
    // Check for URLs and domains
    for (const pattern of urlPatterns) {
        if (pattern.test(message)) {
            return true;
        }
    }
    
    // Check for exact matches of banned words
    for (const word of bannedWords) {
        if (lowerMessage.includes(word)) {
            return true;
        }
    }
    
    // Check for words with common substitutions (like numbers for letters)
    for (const word of bannedWords) {
        // Create pattern to catch common letter replacements
        const pattern = word
            .replace(/a/g, '[a@4]')
            .replace(/e/g, '[e3]')
            .replace(/i/g, '[i1!]')
            .replace(/o/g, '[o0]')
            .replace(/s/g, '[s$5]')
            .replace(/t/g, '[t7]');
        if (new RegExp(pattern, 'i').test(lowerMessage)) {
            return true;
        }
    }
    return false;
}

app.use(cors());

// Socket.io connection handler
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    
    // Track which room this socket is in
    let currentRoom = null;
    
    // When a user joins a chat room for a specific stream
    socket.on('join room', (room) => {
        // Normalize the room ID to ensure consistency
        const normalizedRoom = normalizeRoomId(room);
        
        // Check if this user's IP is banned
        const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        if (bannedIPs.has(clientIP)) {
            // Send message to this user only that they've been banned
            socket.emit('banned');
            return;
        }
        
        // Store the client IP for potential future banning
        socket.clientIP = clientIP;
        
        // Leave previous room if any
        if (currentRoom) {
            socket.leave(currentRoom);
            console.log(`User ${socket.id} left room: ${currentRoom}`);
            
            // Update viewer count for the previous room
            updateViewerCount(currentRoom);
        }
        
        // Join new room
        socket.join(normalizedRoom);
        currentRoom = normalizedRoom;
        console.log(`User ${socket.id} joined room: ${normalizedRoom}`);
        console.log(`Rooms for this socket:`, Array.from(socket.rooms));
        
        // Update and broadcast viewer count for the new room
        const viewerCount = updateViewerCount(normalizedRoom);
        console.log(`Room ${normalizedRoom} now has ${viewerCount} viewers`);
        
        // Get all clients in this room
        const clients = io.sockets.adapter.rooms.get(normalizedRoom);
        const numClients = clients ? clients.size : 0;
        console.log(`Total clients in room ${normalizedRoom}: ${numClients}`);
        
        // Initialize the room's chat history if it doesn't exist
        if (!chatRooms[normalizedRoom]) {
            chatRooms[normalizedRoom] = [];
        }
        
        // Send the room's chat history to the newly connected user
        socket.emit('chat history', chatRooms[normalizedRoom]);
        
        // Send pinned message if it exists for this room
        if (pinnedMessages[normalizedRoom]) {
            socket.emit('pinned message', pinnedMessages[normalizedRoom]);
        }
    });
    
    // When a user pins a message
    socket.on('pin message', (data) => {
        // Only admins can pin messages
        if (!adminSockets.has(socket.id)) {
            socket.emit('admin error', { message: 'Unauthorized: Admin privileges required' });
            return;
        }
        
        const { messageId, room } = data;
        const normalizedRoom = normalizeRoomId(room);
        
        // Find the message in the room's chat history
        const message = chatRooms[normalizedRoom]?.find(msg => msg.id === messageId);
        
        if (message) {
            // Get admin username from the data or use a default
            const adminUsername = data.username || 'Admin';
            
            // Store the pinned message for this room
            pinnedMessages[normalizedRoom] = { ...message, pinnedBy: adminUsername };
            
            // Broadcast to all users in the room
            io.to(normalizedRoom).emit('pinned message', pinnedMessages[normalizedRoom]);
            
            // Send confirmation to the admin
            socket.emit('admin message', {
                message: `Message pinned successfully`
            });
        } else {
            socket.emit('admin error', { message: 'Message not found' });
        }
    });
    
    // When a user unpins a message
    socket.on('unpin message', (data) => {
        // Only admins can unpin messages
        if (!adminSockets.has(socket.id)) {
            socket.emit('admin error', { message: 'Unauthorized: Admin privileges required' });
            return;
        }
        
        const { room } = data;
        const normalizedRoom = normalizeRoomId(room);
        
        // Delete the pinned message for this room
        if (pinnedMessages[normalizedRoom]) {
            delete pinnedMessages[normalizedRoom];
            
            // Broadcast to all users in the room
            io.to(normalizedRoom).emit('unpinned message');
            
            // Send confirmation to the admin
            socket.emit('admin message', {
                message: `Message unpinned successfully`
            });
        }
    });
    
    // When a user sends a chat message
    socket.on('chat message', (data) => {
        console.log(`Chat message received from ${socket.id} in room ${data.room}:`, data.message);
        
        // Normalize the room ID to ensure consistency
        const normalizedRoom = normalizeRoomId(data.room);
        const { message, username, color } = data;
        
        // Store the user's IP with their username
        const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        userIPMap.set(username, clientIP);
        
        // Check for admin login command
        if (message.trim() === ADMIN_CODE) {
            // Add this socket to admin set
            adminSockets.add(socket.id);
            
            // Send admin confirmation message only to this user
            socket.emit('admin auth', { success: true });
            
            // Don't broadcast this message to everyone
            return;
        }
        
        // Check if the message contains banned words or links
        const hasBannedWords = containsBannedWords(message);
        
        // Check specifically for URL patterns to provide a more specific message
        const urlPatterns = [
            /(https?:\/\/[^\s]+)/gi,
            /(www\.[^\s]+)/gi,
            /([a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,})/gi,
            /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g
        ];
        
        let containsLinks = false;
        for (const pattern of urlPatterns) {
            if (pattern.test(message)) {
                containsLinks = true;
                break;
            }
        }
        
        // Check for admin commands
        if (adminSockets.has(socket.id) && message.startsWith('/ban ')) {
            const ipToBan = message.substring(5).trim();
            bannedIPs.add(ipToBan);
            
            // Store the username with banned IP (using "Manual Ban" as username for direct IP bans)
            bannedIPsWithUsernames.set(ipToBan, "Manual Ban");
            
            // Send confirmation to admin only
            socket.emit('chat message', {
                id: Date.now().toString(),
                username: 'System',
                message: `IP ${ipToBan} has been banned`,
                timestamp: new Date().toISOString(),
                color: '#888888',
                isSystem: true
            });
            
            // Broadcast to all users in the room that an IP was banned
            io.to(normalizedRoom).emit('chat message', {
                id: Date.now().toString() + '-ban',
                username: 'System',
                message: `An IP address has been banned by admin`,
                timestamp: new Date().toISOString(),
                color: '#e50914',
                isSystem: true
            });
            
            return;
        }
        
        // Generate a unique ID for the message
        const messageId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
        
        // Create the filtered message text based on what was filtered
        let filteredMessage = message;
        if (hasBannedWords) {
            filteredMessage = containsLinks 
                ? '*** Message filtered: Links and external websites are not allowed ***' 
                : '*** Message filtered due to inappropriate content ***';
        }
        
        // Create a new message object
        const newMessage = {
            id: messageId,
            username: username || 'Anonymous',
            message: hasBannedWords ? filteredMessage : message,
            timestamp: new Date().toISOString(),
            color: color || '#e50914', // Store the user's color or default to red
            filtered: hasBannedWords,
            isAdmin: adminSockets.has(socket.id)
        };
        
        // Store the message in the room's chat history
        if (!chatRooms[normalizedRoom]) {
            chatRooms[normalizedRoom] = [];
            console.log(`Created new chat room: ${normalizedRoom}`);
        }
        chatRooms[normalizedRoom].push(newMessage);
        console.log(`Added message to room ${normalizedRoom}, total messages: ${chatRooms[normalizedRoom].length}`);
        
        // Log room status
        const clients = io.sockets.adapter.rooms.get(normalizedRoom);
        const numClients = clients ? clients.size : 0;
        console.log(`Broadcasting to ${numClients} clients in room ${normalizedRoom}`);
        
        // Check if we've reached 200 messages, if so clear older messages
        // Keep only the most recent 50 messages when clearing
        if (chatRooms[normalizedRoom].length >= 200) {
            // Send notification to all users in the room that history is being cleared
            const systemMessage = {
                id: Date.now().toString() + '-system',
                username: 'System',
                message: 'Chat history has been cleared to improve performance',
                timestamp: new Date().toISOString(),
                color: '#888888',
                isSystem: true
            };
            
            // Keep only the 50 most recent messages
            chatRooms[normalizedRoom] = chatRooms[normalizedRoom].slice(-50);
            
            // Add the system message at the beginning of the retained messages
            chatRooms[normalizedRoom].unshift(systemMessage);
            
            // Notify all users that chat has been cleared
            io.to(normalizedRoom).emit('chat cleared', chatRooms[normalizedRoom]);
            console.log(`Chat cleared notification sent to room ${normalizedRoom}`);
        } else {
            // Broadcast the message to all users in the room
            console.log(`Broadcasting message to room ${normalizedRoom}`);
            
            // Ensure the broadcast goes to all clients in the room by using io.in() or io.to()
            io.in(normalizedRoom).emit('chat message', newMessage);
            
            // Log confirmation of broadcast
            console.log(`Message broadcast complete to room ${normalizedRoom}`);
        }
    });
    
    // When a user disconnects
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Update viewer count for the room if the user was in one
        if (currentRoom) {
            // Add a small delay to ensure the room is updated before counting
            setTimeout(() => {
                updateViewerCount(currentRoom);
            }, 100);
        }
        // No need to manually leave rooms, Socket.IO does this automatically
    });
    
    // Log errors
    socket.on('error', (error) => {
        console.error('Socket error:', error);
    });

    // Add a new socket event for validating usernames
    socket.on('validate username', (data) => {
        const { username } = data;
        const hasBannedWords = containsBannedWords(username);
        
        // Check specifically for URL patterns in usernames
        const urlPatterns = [
            /(https?:\/\/[^\s]+)/gi,
            /(www\.[^\s]+)/gi,
            /([a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,})/gi,
            /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g
        ];
        
        let containsLinks = false;
        for (const pattern of urlPatterns) {
            if (pattern.test(username)) {
                containsLinks = true;
                break;
            }
        }
        
        // Customize the message based on what was detected
        let message = 'Username is valid';
        if (hasBannedWords) {
            message = containsLinks 
                ? 'Username cannot contain links or domain names' 
                : 'Username contains inappropriate content';
        }
        
        // Send the result back to the client
        socket.emit('username validation', {
            valid: !hasBannedWords,
            message: message
        });
    });

    // Add a new socket event for banning users by username
    socket.on('ban user', (data) => {
        // Only admins can ban users
        if (!adminSockets.has(socket.id)) {
            socket.emit('admin error', { message: 'Unauthorized: Admin privileges required' });
            return;
        }
        
        const { username, room } = data;
        const normalizedRoom = normalizeRoomId(room);
        
        // Get the IP associated with this username
        const ipToBan = userIPMap.get(username);
        if (ipToBan) {
            // Add to banned list
            bannedIPs.add(ipToBan);
            
            // Store the username with the banned IP
            bannedIPsWithUsernames.set(ipToBan, username);
            
            // Send confirmation to the admin
            socket.emit('chat message', {
                id: Date.now().toString(),
                username: 'System',
                message: `User ${username} has been banned`,
                timestamp: new Date().toISOString(),
                color: '#888888',
                isSystem: true
            });
            
            // Broadcast to all users in the room that this user was banned
            io.to(normalizedRoom).emit('chat message', {
                id: Date.now().toString() + '-ban',
                username: 'System',
                message: `User ${username} has been banned by admin`,
                timestamp: new Date().toISOString(),
                color: '#e50914',
                isSystem: true
            });
            
            // Send notification to the banned user if they're still connected
            // Using modern Socket.IO methods to get clients
            const sockets = io.sockets.adapter.rooms.get(normalizedRoom);
            if (sockets) {
                for (const socketId of sockets) {
                    const clientSocket = io.sockets.sockets.get(socketId);
                    if (clientSocket) {
                        const clientSocketIP = clientSocket.handshake.headers['x-forwarded-for'] || clientSocket.handshake.address;
                        if (clientSocketIP === ipToBan) {
                            clientSocket.emit('banned');
                        }
                    }
                }
            }
        } else {
            // Username not found
            socket.emit('admin error', { message: 'User not found or has left the chat' });
        }
    });

    // Handle pinned message
    socket.on('pinned message', (message) => {
        // Create the pinned message UI
        pinnedMessageContainer.innerHTML = 
            '<div class="pinned-message-header">' +
                '<div class="pinned-message-icon">' +
                    '<span class="pin-icon">📌</span>' +
                    '<span>Pinned message</span>' +
                '</div>' +
                (isAdmin ? '<button class="unpin-button" onclick="unpinMessage()">×</button>' : '') +
            '</div>' +
            '<div class="pinned-message-content">' +
                '<span class="pinned-username" style="color: ' + message.color + '">' + message.username + '</span>' +
                '<span>' + message.message + '</span>' +
            '</div>';
        
        // Show the pinned message container
        pinnedMessageContainer.style.display = 'block';
    });

    // When a user deletes a message
    socket.on('delete message', (data) => {
        // Only admins can delete messages
        if (!adminSockets.has(socket.id)) {
            socket.emit('admin error', { message: 'Unauthorized: Admin privileges required' });
            return;
        }
        
        const { messageId, room } = data;
        const normalizedRoom = normalizeRoomId(room);
        console.log(`Admin attempting to delete message ${messageId} in room ${normalizedRoom}`);
        
        // Find the message in the room's chat history
        if (chatRooms[normalizedRoom]) {
            // Find the message index
            const messageIndex = chatRooms[normalizedRoom].findIndex(msg => msg.id === messageId);
            console.log(`Found message at index ${messageIndex}`);
            
            // If message found, replace it with a "deleted" message
            if (messageIndex !== -1) {
                // Save the original username and colors
                const originalMessage = chatRooms[normalizedRoom][messageIndex];
                const adminUsername = data.username || 'Admin';
                
                console.log(`Deleting message: "${originalMessage.message}" from user: ${originalMessage.username}`);
                
                // Replace with deleted message notice
                chatRooms[normalizedRoom][messageIndex] = {
                    ...originalMessage,
                    message: '*** Message deleted by admin ***',
                    deleted: true,
                    deletedBy: adminUsername,
                    timestamp: new Date().toISOString()
                };
                
                // Broadcast the deletion to all users in the room
                io.to(normalizedRoom).emit('message deleted', {
                    messageId,
                    deletedMessage: chatRooms[normalizedRoom][messageIndex]
                });
                
                console.log(`Message deleted and broadcast to room ${normalizedRoom}`);
                
                // Send confirmation to the admin
                socket.emit('admin message', {
                    message: `Message deleted successfully`
                });
            } else {
                console.log(`Message ${messageId} not found in room ${normalizedRoom}`);
                socket.emit('admin error', { message: 'Message not found' });
            }
        } else {
            console.log(`Chat room ${normalizedRoom} not found`);
            socket.emit('admin error', { message: 'Chat room not found' });
        }
    });

    // Listen for message deleted events
    socket.on('message deleted', (data) => {
        console.log('Message deleted event received:', data);
        const { messageId, deletedMessage } = data;
        
        // Find the message element in the DOM
        const messageElement = document.querySelector('.chat-message[data-message-id="' + messageId + '"]');
        console.log('Found message element:', messageElement);
        
        if (messageElement) {
            // Update the content to show it's deleted
            const contentSpan = messageElement.querySelector('.chat-message-content');
            if (contentSpan) {
                contentSpan.textContent = ' ' + deletedMessage.message;
                contentSpan.className = 'chat-message-content deleted-message';
                console.log('Updated message content to show deleted');
            }
            
            // Remove any action buttons since the message is now deleted
            const actionsDiv = messageElement.querySelector('.message-actions');
            if (actionsDiv) {
                actionsDiv.remove();
                console.log('Removed action buttons');
            }
        } else {
            console.log('Message element not found in DOM');
        }
    });
    
    // Function to add pin button to a message
    function addPinButtonToMessage(messageElement) {
        // Only add if not already present
        if (!messageElement.querySelector('.message-actions')) {
            const messageId = messageElement.getAttribute('data-message-id');
            
            // Create the action buttons container
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'message-actions';
            
            // Create pin button
            const pinButton = document.createElement('button');
            pinButton.className = 'pin-message-btn';
            pinButton.innerHTML = '📌';
            pinButton.title = 'Pin message';
            pinButton.onclick = function(e) {
                e.stopPropagation();
                socket.emit('pin message', {
                    messageId: messageId,
                    room: chatRoom,
                    username: username
                });
            };
            
            // Create delete button
            const deleteButton = document.createElement('button');
            deleteButton.className = 'delete-message-btn';
            deleteButton.innerHTML = '🗑️';
            deleteButton.title = 'Delete message';
            deleteButton.onclick = function(e) {
                e.stopPropagation();
                if (confirm('Delete this message?')) {
                    socket.emit('delete message', {
                        messageId: messageId,
                        room: chatRoom,
                        username: username
                    });
                }
            };
            
            // Add buttons to actions container
            actionsDiv.appendChild(pinButton);
            actionsDiv.appendChild(deleteButton);
            
            // Add actions container to message
            messageElement.appendChild(actionsDiv);
        }
    }
});

app.use(express.static('public'));










// Add this new endpoint to display sports
app.get('/', async (req, res) => {
    try {
        const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));

        const safeFetch = async (url) => {
            try {
                const result = await Promise.race([
                    fetchWithHeaders(url),
                    timeout(8000)
                ]);

                if (!result || !result.ok) {
                    return null;
                }

                try {
                    return await result.json();
                } catch (parseError) {
                    return null;
                }
            } catch {
                return null;
            }
        };

        const sports = await safeFetch('https://streamed.su/api/sports') || [];
        const liveMatches = await safeFetch('https://streamed.su/api/matches/live/popular') || [];

        // Filter matches to only include those with a source
        const validLiveMatches = (liveMatches || []).filter(match => match.sources && match.sources.length > 0);

        // Generate HTML for sports rows
        const sportsRows = sports.map(sport => {
            return `
                <div class="sport-category">
                    <h2 class="category-title">${sport.name}</h2>
                    <div class="sport-row">
                        <div class="sport-card" onclick="location.href='/sports/${sport.id}'">
                            <div class="sport-card-inner">
                                <div class="sport-name">${sport.name}</div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        // Generate HTML for live matches
        const liveMatchesHtml = validLiveMatches.length > 0 ? `
            <div class="sport-category">
                <h2 class="category-title">Live Popular Matches</h2>
                <div class="sport-row-container">
                    ${validLiveMatches.length > 1 ? `
                        <button class="scroll-btn scroll-left" onclick="scrollSportRow(this.closest('.sport-row-container').querySelector('.sport-row'), 'left')">&#10094;</button>
                        <button class="scroll-btn scroll-right" onclick="scrollSportRow(this.closest('.sport-row-container').querySelector('.sport-row'), 'right')">&#10095;</button>
                    ` : ''}
                    <div class="sport-row">
                        ${validLiveMatches.map(match => {
                            // Store the sources and IDs
                            const firstSource = match.sources[0];
                            const matchTitle = match.title || 'Live Match';
                            
                            // Get second and third sources if available, or use the first source as fallback
                            const secondSource = match.sources[1] || match.sources[0];
                            const thirdSource = match.sources[2] || match.sources[0];
                            
                            // Generate the team badges if available
                            let teamBadges = '';
                            if (match.teams) {
                                teamBadges = `
                                    <div class="teams-display">
                                        <div class="team-name home-team">${match.teams.home?.name || 'Home'}</div>
                                        <div class="vs-text">VS</div>
                                        <div class="team-name away-team">${match.teams.away?.name || 'Away'}</div>
                                    </div>
                                `;
                            }

                            return `
                                <div class="match-card" 
                                     data-source="${firstSource.source}" 
                                     data-id="${firstSource.id}"
                                     onclick="location.href='/watch-sport/${firstSource.source}/${firstSource.id}/${secondSource.source}/${secondSource.id}/${thirdSource.source}/${thirdSource.id}'">
                                    <div class="match-gradient-bg">
                                        <div class="match-info">
                                            <div class="match-title">${matchTitle}</div>
                                            ${teamBadges}
                                            <div class="live-indicator">LIVE</div>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            </div>
        ` : '';

        // Send the complete HTML response
        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Live Sports - ALLSTREAMCC.COM</title>
                <meta name="description" content="Watch live sports streams on AllStreamCC.com. Free live sports streaming for football, basketball, soccer, and more. AllStream.cc - Your destination for live sports.">
                <meta name="keywords" content="allstream.cc, allstreamcc.com, live sports, sports streaming, free sports streams, live football, live basketball, watch sports online">
                <meta property="og:title" content="Live Sports - ALLSTREAMCC.COM">
                <meta property="og:description" content="Watch live sports streams on AllStreamCC.com. Free live sports streaming for football, basketball, soccer, and more.">
                <meta property="og:site_name" content="AllStreamCC.com">
                <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">
                <link rel="icon" href="https://th.bing.com/th/id/R.17dea5ebc20f4fd10389b4f180ae9b3d?rik=e9t%2fhvOQADZM1g&riu=http%3a%2f%2fclipart-library.com%2fimages%2f8i65B8AXT.png&ehk=ruY7nFucsGPNXtLQ6BYoDblZX0Klw15spn25fXFppPs%3d&risl=&pid=ImgRaw&r=0">
                
                <script>
                    // Function to change the stream source
                    function changeStream(embedUrl, buttonElement) {
                        // Update the iframe src
                        const iframe = document.getElementById('streamIframe');
                        if (iframe) {
                            iframe.src = embedUrl;
                            console.log('Stream changed to:', embedUrl);
                        }
                        
                        // Remove active class from all stream buttons
                        const allButtons = document.querySelectorAll('.stream-button');
                        allButtons.forEach(btn => btn.classList.remove('active'));
                        
                        // Add active class to the clicked button
                        if (buttonElement) {
                            buttonElement.classList.add('active');
                        }
                    }
                    
                    // Add event delegation for stream buttons
                    document.addEventListener('DOMContentLoaded', function() {
                        document.addEventListener('click', function(e) {
                            if (e.target.classList.contains('stream-button')) {
                                const embedUrl = e.target.getAttribute('data-embed-url');
                                changeStream(embedUrl, e.target);
                            }
                        });
                    });
                </script>
                
                <style>
                    :root {
                        --primary: #e50914;
                        --dark: #141414;
                        --darker: #000000;
                        --light: #ffffff;
                        --gray: #808080;
                        --transparent-dark: rgba(20, 20, 20, 0.7);
                    }

                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                        font-family: 'Montserrat', sans-serif;
                    }

                    body {
                        background: var(--dark);
                        color: var(--light);
                        line-height: 1.6;
                    }

                    .navbar {
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        height: 68px;
                        padding: 0 4%;
                        background: linear-gradient(180deg, var(--darker) 0%, transparent 100%);
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        z-index: 1000;
                        transition: background-color 0.3s;
                    }

                    .navbar.scrolled {
                        background: var(--darker);
                    }

                    .logo {
                        color: var(--primary);
                        text-decoration: none;
                        font-size: 1.8rem;
                        font-weight: 700;
                    }

                    .logo span {
                        color: var(--light);
                    }

                    .search-container {
                        position: relative;
                        max-width: 500px;
                        width: 100%;
                    }

                    .search-bar {
                        width: 100%;
                        padding: 10px 16px;
                        background: var(--transparent-dark);
                        border: 1px solid rgba(255, 255, 255, 0.2);
                        border-radius: 4px;
                        color: var(--light);
                        font-size: 1rem;
                    }

                    .search-bar:focus {
                        outline: none;
                        border-color: var(--light);
                    }

                    .search-button {
                        position: absolute;
                        right: 8px;
                        top: 50%;
                        transform: translateY(-50%);
                        background: var(--primary);
                        color: var(--light);
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-weight: 500;
                    }

                    .search-button:hover {
                        background: #f40612;
                    }

                    .main-content {
                        padding: 90px 4% 2rem;
                    }

                    .page-title {
                        font-size: 2.5rem;
                        font-weight: 700;
                        margin-bottom: 2rem;
                    }

                    .sport-category {
                        margin-bottom: 3rem;
                        position: relative;
                    }

                    .category-title {
                        font-size: 1.5rem;
                        font-weight: 600;
                        margin-bottom: 1rem;
                        padding-bottom: 0.5rem;
                        border-bottom: 2px solid rgba(255, 255, 255, 0.1);
                    }

                    .sport-row-container {
                        position: relative;
                        margin: 1rem 0;
                    }
                    
                    .sport-row {
                        display: flex;
                        overflow-x: auto;
                        gap: 0.5rem;
                        scroll-behavior: smooth;
                        -webkit-overflow-scrolling: touch;
                        padding: 10px 40px;  /* Add padding to make room for buttons */
                    }
                    
                    .scroll-btn {
                        position: absolute;
                        top: 50%;
                        transform: translateY(-50%);
                        background: rgba(0, 0, 0, 0.7);
                        color: white;
                        border: none;
                        border-radius: 50%;
                        width: 40px;
                        height: 40px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 1.2rem;
                        cursor: pointer;
                        z-index: 100;
                        opacity: 0.8;
                        transition: opacity 0.3s;
                    }
                    
                    .scroll-btn:hover {
                        opacity: 1;
                    }
                    
                    .scroll-left {
                        left: 0;
                    }
                    
                    .scroll-right {
                        right: 0;
                    }

                    .sport-card {
                        flex: 0 0 auto;
                        width: 200px;
                        height: 100px;
                        background: linear-gradient(135deg, var(--primary) 0%, #990000 100%);
                        border-radius: 8px;
                        cursor: pointer;
                        overflow: hidden;
                        transition: transform 0.3s ease, box-shadow 0.3s ease;
                        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                    }

                    .sport-card:hover {
                        transform: translateY(-5px);
                        box-shadow: 0 8px 16px rgba(0, 0, 0, 0.6);
                    }

                    .sport-card-inner {
                        height: 100%;
                        width: 100%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        text-align: center;
                        padding: 1rem;
                    }

                    .sport-name {
                        font-size: 1.3rem;
                        font-weight: 600;
                        color: var(--light);
                    }

                    .match-card {
                        flex: 0 0 auto;
                        width: 400px;
                        height: 220px;
                        border-radius: 8px;
                        overflow: hidden;
                        cursor: pointer;
                        transition: transform 0.3s ease, box-shadow 0.3s ease;
                        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                        position: relative;
                        margin: 5px;
                    }

                    .match-gradient-bg {
                        width: 100%;
                        height: 100%;
                        background: linear-gradient(135deg, #e50914 0%, #7b0810 100%);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 1.5rem;
                        position: relative;
                    }

                    .match-info {
                        text-align: center;
                        z-index: 2;
                        padding: 1rem;
                        width: 100%;
                    }

                    .match-title {
                        font-size: 1.3rem;
                        font-weight: 700;
                        margin-bottom: 1rem;
                        color: var(--light);
                        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
                    }

                    .teams-display {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 1rem;
                        margin: 1rem 0;
                    }

                    .team-name {
                        font-size: 1.1rem;
                        font-weight: 600;
                        color: white;
                        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
                    }

                    .vs-text {
                        font-size: 0.9rem;
                        color: rgba(255, 255, 255, 0.8);
                        font-weight: 500;
                    }

                    .live-indicator {
                        position: absolute;
                        top: 10px;
                        right: 10px;
                        background: rgba(0, 0, 0, 0.5);
                        color: var(--light);
                        font-size: 0.7rem;
                        font-weight: 700;
                        padding: 5px 10px;
                        border-radius: 4px;
                        letter-spacing: 1px;
                        border: 1px solid rgba(255, 255, 255, 0.3);
                    }

                    .popular-indicator {
                        position: absolute;
                        top: 10px;
                        left: 10px;
                        background: var(--primary);
                        color: var(--light);
                        font-size: 0.7rem;
                        font-weight: 700;
                        padding: 5px 10px;
                        border-radius: 4px;
                        letter-spacing: 1px;
                        border: 1px solid rgba(255, 255, 255, 0.3);
                    }

                    .match-card:hover {
                        transform: translateY(-5px);
                        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.7);
                    }

                    .match-card:hover .match-gradient-bg {
                        background: linear-gradient(135deg, #ff0f1a 0%, #9b0813 100%);
                    }

                    .match-poster {
                        width: 100%;
                        height: 220px;
                        object-fit: contain;
                        background-color: #0a0a0a;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }

                    .match-time {
                        display: inline-block;
                        background: rgba(255, 255, 255, 0.1);
                        padding: 4px 8px;
                        border-radius: 4px;
                        font-size: 0.8rem;
                        color: var(--light);
                        margin-top: 0.5rem;
                    }

                    .no-matches {
                        background: rgba(0, 0, 0, 0.3);
                        padding: 2rem;
                        text-align: center;
                        border-radius: 8px;
                        margin-bottom: 2rem;
                        color: var(--gray);
                        font-size: 1.2rem;
                    }

                    @media (max-width: 768px) {
                        .navbar {
                            height: auto;
                            padding: 1rem 4%;
                            flex-direction: column;
                            gap: 1rem;
                        }

                        .search-container {
                            width: 100%;
                        }

                        .main-content {
                            padding-top: 140px;
                        }

                        .page-title {
                            font-size: 2rem;
                        }

                        .sport-card {
                            width: 150px;
                        }

                        .match-card {
                            width: 320px;
                        }
                        
                        .match-poster {
                            height: 180px;
                        }
                    }
                    
                    .disclaimer-section {
                        margin-top: 3rem;
                        padding: 2rem;
                        background: rgba(0, 0, 0, 0.3);
                        border-radius: 8px;
                        border-top: 2px solid rgba(255, 255, 255, 0.1);
                    }
                    
                    .disclaimer-content {
                        text-align: center;
                        color: var(--gray);
                        font-size: 0.9rem;
                        line-height: 1.6;
                    }
                    
                    .disclaimer-content p {
                        margin-bottom: 0.5rem;
                    }
                    
                    .disclaimer-content a {
                        color: var(--primary);
                        text-decoration: none;
                    }
                    
                    .disclaimer-content a:hover {
                        text-decoration: underline;
                    }
                </style>

                <script
                  type="text/javascript"
                  src="https://pl28055385.effectivegatecpm.com/c6/d8/57/c6d857d6d0087430d0c9bd203d8b610d.js"
                ></script>
            </head>
            <body>
                <nav class="navbar">
                    <a href="/" class="logo">allstream<span>cc.com</span></a>
                   
                </nav>

                <main class="main-content">
                    <h1 class="page-title">Live Sports</h1>
                    
                    ${liveMatchesHtml}
                    
                    ${sportsRows}
                    
                    <div class="disclaimer-section">
                        <div class="disclaimer-content">
                            <p><strong>Contact:</strong> Please contact us through the Signal app @vookspook.26</p>
                            <p><strong>Disclaimer:</strong> We do not control any of the content posted. All content hosted is on 3rd party servers.</p>
                        </div>
                    </div>
                </main>
                

                <script>
                    // Navbar background on scroll
                    window.addEventListener('scroll', () => {
                        const navbar = document.querySelector('.navbar');
                        if (window.scrollY > 20) {
                            navbar.classList.add('scrolled');
                        } else {
                            navbar.classList.remove('scrolled');
                        }
                    });

                    // Function to scroll sport rows
                    function scrollSportRow(row, direction) {
                        const scrollAmount = 450;
                        if (direction === 'left') {
                            row.scrollBy({
                                left: -scrollAmount,
                                behavior: 'smooth'
                            });
                        } else {
                            row.scrollBy({
                                left: scrollAmount,
                                behavior: 'smooth'
                            });
                        }
                    }

                    // Search functionality
                    function performSearch() {
                        const query = document.getElementById('searchInput').value.trim();
                        if (query) {
                            window.location.href = '/search/' + encodeURIComponent(query);
                        }
                    }

                    // Enter key search trigger
                    document.getElementById('searchInput').addEventListener('keypress', (e) => {
                        if (e.key === 'Enter') {
                            performSearch();
                        }
                    });
                </script>
                <!-- Google tag (gtag.js) -->
                <script async src="https://www.googletagmanager.com/gtag/js?id=G-5D5C0M4BFT"></script>
                <script>
                    window.dataLayer = window.dataLayer || [];
                    function gtag(){dataLayer.push(arguments);}
                    gtag('js', new Date());
                    gtag('config', 'G-5D5C0M4BFT');
                </script>

                <script>
                    // Last resort protection
                    (function() {
                        // Save initial URL
                        var initialUrl = window.location.href;
                        
                        // Poll for URL changes and restore if changed
                        setInterval(function() {
                            if (window.location.href !== initialUrl) {
                                history.replaceState(null, '', initialUrl);
                            }
                        }, 200);
                    })();
                </script>
              
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Error in home endpoint:', error);
        res.status(500).send('An error occurred while fetching sports data.');
    }
});

// Add this new endpoint to watch sports streams
app.get('/watch-sport/:source/:id/:secondsource/:secondid/:thirdsource/:thirdid', async (req, res) => {
    try {
        // Extract parameters from the request
        const source = req.params.source;
        const id = req.params.id;
        
        // Use default values for second and third sources if they don't exist or are invalid
        // Default fallback is to use the primary source 
        const secondsource = req.params.secondsource || source;
        const secondid = req.params.secondid || id;
        const thirdsource = req.params.thirdsource || source;
        const thirdid = req.params.thirdid || id;
        
        const chatRoom = `${source}-${id}`; // Create a unique room ID from source and id

        // Fetch streams for the given source and ID
        const streamsResponse = await fetchWithHeaders(`https://streamed.su/api/stream/${source}/${id}`);
        
        // For second and third sources, use try/catch to handle potential fetch errors
        let secondstreams = [];
        try {
            const secondstreamsResponse = await fetchWithHeaders(`https://streamed.su/api/stream/${secondsource}/${secondid}`);
            if (secondstreamsResponse.ok) {
                secondstreams = await secondstreamsResponse.json();
            }
        } catch (error) {
            console.error(`Error fetching second source streams: ${error.message}`);
        }
        
        let thirdstreams = [];
        try {
            const thirdstreamsResponse = await fetchWithHeaders(`https://streamed.su/api/stream/${thirdsource}/${thirdid}`);
            if (thirdstreamsResponse.ok) {
                thirdstreams = await thirdstreamsResponse.json();
            }
        } catch (error) {
            console.error(`Error fetching third source streams: ${error.message}`);
        }
        
        // Check if the primary response is ok before trying to parse JSON
        if (!streamsResponse.ok) {
            throw new Error(`API responded with status: ${streamsResponse.status}`);
        }
        
        const streams = await streamsResponse.json();

        // Check if streams array exists and has items
        if (!Array.isArray(streams) || streams.length === 0) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>No Streams Available</title>
                    <style>
                        body {
                            font-family: 'Montserrat', sans-serif;
                            background: #141414;
                            color: white;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                            text-align: center;
                        }
                        .error-container {
                            max-width: 600px;
                            padding: 2rem;
                        }
                        h1 {
                            color: #e50914;
                            margin-bottom: 1rem;
                        }
                        p {
                            color: #999;
                            margin-bottom: 2rem;
                        }
                        a {
                            display: inline-block;
                            background: #e50914;
                            color: white;
                            padding: 10px 20px;
                            text-decoration: none;
                            border-radius: 4px;
                        }
                    </style>

                <script
                  type="text/javascript"
                  src="https://pl28055385.effectivegatecpm.com/c6/d8/57/c6d857d6d0087430d0c9bd203d8b610d.js"
                ></script>
                </head>
                <body>
                    <div class="error-container">
                        <h1>No Streams Available</h1>
                        <p>We couldn't find any streams for this event. This may be because the game hasn't started yet or there are no available streaming sources.</p>
                        <a href="/">Go Back to Sports</a>
                    </div>
  

                </body>
                </html>
            `);
        }

        // Fetch match details to get the title and other metadata
        const matchResponse = await fetchWithHeaders(`https://streamed.su/api/matches/live`);
        
        // Check if the response is ok before trying to parse JSON
        if (!matchResponse.ok) {
            throw new Error(`API responded with status: ${matchResponse.status}`);
        }
        
        const matches = await matchResponse.json();
        
        // Find the match with the same source and ID
        const match = matches.find(m => 
            m.sources && m.sources.some(s => s.source === source && s.id === id)
        ) || { title: 'Live Sport Event', category: 'Sports' };

        // Default to the first stream if available
        const defaultStream = streams.length > 0 ? streams[0] : null;
        const embedUrl = defaultStream ? defaultStream.embedUrl : '';
        
        // Generate streams list for all three sources
        // First source streams
        const streamsList = streams.map((stream, index) => {
            return `
                <button class="stream-button ${index === 0 ? 'active' : ''}" 
                        data-embed-url="${stream.embedUrl}">
                    Source 1 - Stream ${stream.streamNo} ${stream.hd ? '(HD)' : ''} ${stream.language ? `- ${stream.language}` : ''}
                </button>
            `;
        }).join('');
        
        // Second source streams
        const secondStreamsList = Array.isArray(secondstreams) && secondstreams.length > 0 ? 
            secondstreams.map((stream, index) => {
                return `
                                    <button class="stream-button" 
                        data-embed-url="${stream.embedUrl}">
                    Source 2 - Stream ${stream.streamNo} ${stream.hd ? '(HD)' : ''} ${stream.language ? `- ${stream.language}` : ''}
                </button>
                `;
            }).join('') : '';
        
        // Third source streams
        const thirdStreamsList = Array.isArray(thirdstreams) && thirdstreams.length > 0 ? 
            thirdstreams.map((stream, index) => {
                return `
                                    <button class="stream-button" 
                        data-embed-url="${stream.embedUrl}">
                    Source 3 - Stream ${stream.streamNo} ${stream.hd ? '(HD)' : ''} ${stream.language ? `- ${stream.language}` : ''}
                </button>
                `;
            }).join('') : '';
        
        // Combine all streams
        const allStreamsList = streamsList + secondStreamsList + thirdStreamsList;

        // Add the chat UI to the HTML before the closing </main> tag
        const chatUI = `
            <div class="chat-container" id="chat-container">
                <h3 class="chat-header">
                    Live Chat
                    <div class="chat-controls">
                        <span class="viewer-count" id="viewer-count">0 viewers</span>
                        <button id="toggle-chat" class="toggle-chat-btn">Hide Chat</button>
                    </div>
                </h3>
                <div id="pinned-message-container" class="pinned-message-container" style="display: none;"></div>
                <div class="chat-messages" id="chat-messages">
                    <div class="chat-loading">Loading chat...</div>
                </div>
                <div class="username-selection">
                    <input type="text" id="username-input" placeholder="Choose your username" class="username-input">
                    <button id="set-username" class="set-username-btn">Set</button>
                </div>
                <div class="chat-form">
                    <input type="text" id="message-input" placeholder="Type a message..." class="message-input">
                    <button id="send-button" class="send-button">Send</button>
                </div>
                <div class="admin-section">
                    <button id="admin-login-btn" class="admin-login-btn">Admin</button>
                </div>
            </div>
        `;

        // Add chat CSS to the style section
        const chatCSS = `
            /* Flex layout for content area on desktop */
            .content-wrapper {
                display: flex;
                flex-direction: row;
                gap: 1.5rem;
                margin-bottom: 2rem;
            }
            
            .player-wrapper {
                flex: 2;
                min-width: 0; /* Prevent flexbox from allowing overflow */
            }
            
            .stream-notice {
                background: rgba(255, 204, 0, 0.1);
                border-left: 4px solid #fc0;
                border-radius: 4px;
                padding: 12px 16px;
                margin-bottom: 16px;
                display: flex;
                align-items: center;
            }
            
            .notice-content {
                display: flex;
                align-items: center;
                color: #e5e5e5;
                font-size: 14px;
            }
            
            .notice-icon {
                font-style: normal;
                margin-right: 10px;
                font-size: 16px;
            }
            
            .chat-container {
                width: 400px;
                height: 600px; /* Fixed height */
                border-radius: 8px;
                background: #222;
                overflow: hidden;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                display: flex;
                flex-direction: column;
                flex: 1;
            }
            
            .chat-header {
                background: var(--primary);
                color: white;
                padding: 0.8rem 1.2rem;
                margin: 0;
                font-size: 1.2rem;
                font-weight: 600;
                flex-shrink: 0;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            
            .chat-controls {
                display: flex;
                align-items: center;
                gap: 0.8rem;
            }
            
            .toggle-chat-btn {
                background: rgba(0, 0, 0, 0.3);
                border: none;
                color: white;
                padding: 0.3rem 0.6rem;
                border-radius: 12px;
                cursor: pointer;
                font-size: 0.9rem;
                transition: background 0.2s;
            }
            
            .toggle-chat-btn:hover {
                background: rgba(0, 0, 0, 0.5);
            }
            
            .viewer-count {
                font-size: 0.9rem;
                background: rgba(0, 0, 0, 0.3);
                padding: 0.3rem 0.6rem;
                border-radius: 12px;
                font-weight: 400;
            }
            
            .pinned-message-container {
                background: rgba(229, 9, 20, 0.15);
                border-left: 3px solid var(--primary);
                margin: 0;
                padding: 12px;
                position: relative;
                flex-shrink: 0;
            }
            
            .pinned-message-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 0.8rem;
                color: rgba(255, 255, 255, 0.7);
                margin-bottom: 5px;
            }
            
            .pinned-message-icon {
                display: flex;
                align-items: center;
                gap: 4px;
            }
            
            .pin-icon {
                font-size: 12px;
            }
            
            .unpin-button {
                background: none;
                border: none;
                color: rgba(255, 255, 255, 0.7);
                cursor: pointer;
                font-size: 0.8rem;
                padding: 0;
                display: flex;
                align-items: center;
            }
            
            .unpin-button:hover {
                color: white;
            }
            
            .pinned-message-content {
                font-size: 0.95rem;
                color: white;
                display: flex;
                flex-direction: column;
            }
            
            .pinned-username {
                font-weight: 600;
                margin-right: 0.5rem;
            }
            
            .chat-messages {
                flex-grow: 1;
                height: 350px; /* Fixed height for message area */
                max-height: 350px; /* Ensure it doesn't grow beyond this */
                overflow-y: auto;
                padding: 1rem;
                background: #222;
                color: white;
                display: flex;
                flex-direction: column;
                scrollbar-width: thin;
                scrollbar-color: var(--primary) #333;
            }
            
            /* Custom scrollbar for Chrome, Edge, and Safari */
            .chat-messages::-webkit-scrollbar {
                width: 8px;
            }
            
            .chat-messages::-webkit-scrollbar-track {
                background: #333;
            }
            
            .chat-messages::-webkit-scrollbar-thumb {
                background-color: var(--primary);
                border-radius: 20px;
            }
            
            .chat-loading {
                text-align: center;
                color: var(--gray);
                padding: 1rem;
            }
            
            .chat-message {
                margin-bottom: 0.8rem;
                max-width: 90%;
                word-wrap: break-word;
                animation: fadeIn 0.2s ease-in;
                position: relative;
            }
            
            .message-actions {
                position: absolute;
                right: 0;
                top: 0;
                display: none;
                background: rgba(20, 20, 20, 0.7);
                border-radius: 4px;
                padding: 2px;
                display: flex;
                gap: 2px;
            }
            
            .chat-message:hover .message-actions {
                display: flex;
            }
            
            .pin-message-btn {
                background: none;
                border: none;
                color: rgba(255, 255, 255, 0.7);
                cursor: pointer;
                font-size: 0.8rem;
                padding: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                border-radius: 4px;
                transition: all 0.2s;
            }
            
            .pin-message-btn:hover {
                background: rgba(255, 255, 255, 0.2);
                color: white;
            }
            
            .delete-message-btn {
                background: none;
                border: none;
                color: rgba(255, 255, 255, 0.7);
                cursor: pointer;
                font-size: 0.8rem;
                padding: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                border-radius: 4px;
                transition: all 0.2s;
            }
            
            .delete-message-btn:hover {
                background: rgba(229, 9, 20, 0.4);
                color: white;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(5px); }
                to { opacity: 1; transform: translateY(0); }
            }
            
            .chat-username {
                font-weight: 600;
                margin-right: 0.5rem;
            }
            
            .clickable-username {
                cursor: pointer;
                text-decoration: underline;
                text-decoration-style: dotted;
                text-decoration-thickness: 1px;
                text-underline-offset: 3px;
            }
            
            .clickable-username:hover {
                text-decoration-style: solid;
            }
            
            .admin-badge {
                background-color: var(--primary);
                color: white;
                font-size: 0.7rem;
                padding: 0.1rem 0.3rem;
                border-radius: 4px;
                margin-left: 0.3rem;
                vertical-align: middle;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(5px); }
                to { opacity: 1; transform: translateY(0); }
            }
            
            .send-button:hover {
                background: #c7000a;
            }
            
            .admin-section {
                text-align: center;
                padding: 0.5rem;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                background: #1a1a1a;
            }
            
            .admin-login-btn {
                background: transparent;
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: rgba(255, 255, 255, 0.6);
                padding: 0.3rem 0.8rem;
                border-radius: 4px;
                cursor: pointer;
                font-size: 0.8rem;
                transition: all 0.2s;
            }
            
            .admin-login-btn:hover {
                background: rgba(255, 255, 255, 0.1);
                color: rgba(255, 255, 255, 0.8);
            }
            
            .admin-login-btn.active {
                background: var(--primary);
                color: white;
                border-color: var(--primary);
            }
            
            .username-selection {
                display: flex;
                padding: 0.8rem;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                background: #1a1a1a;
                flex-shrink: 0;
            }
            
            .username-input {
                flex-grow: 1;
                padding: 0.6rem 1rem;
                border: none;
                background: rgba(255, 255, 255, 0.1);
                color: white;
                border-radius: 4px 0 0 4px;
            }
            
            .set-username-btn {
                padding: 0.6rem 1rem;
                border: none;
                border-radius: 0 4px 4px 0;
                background: #444;
                color: white;
                cursor: pointer;
                font-weight: 500;
                transition: background 0.2s;
            }
            
            .set-username-btn:hover {
                background: #555;
            }
            
            .chat-form {
                display: flex;
                padding: 0.8rem;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                background: #1a1a1a;
                flex-shrink: 0;
            }
            
            .message-input {
                flex-grow: 1;
                padding: 0.6rem 1rem;
                border: none;
                background: rgba(255, 255, 255, 0.1);
                color: white;
                border-radius: 4px 0 0 4px;
            }
            
            .send-button {
                padding: 0.6rem 1.2rem;
                border: none;
                border-radius: 0 4px 4px 0;
                background: var(--primary);
                color: white;
                cursor: pointer;
                font-weight: 500;
            }
            
            .send-button:hover {
                background: #f40612;
            }
            
            .chat-message-content {
                display: inline;
            }
            
            .filtered-message {
                color: #888;
                font-style: italic;
            }
            
            .deleted-message {
                color: #888;
                font-style: italic;
                text-decoration: line-through;
                opacity: 0.8;
            }
            
            .system-message {
                background: rgba(0, 0, 0, 0.2);
                color: #aaa;
                padding: 8px 12px;
                border-radius: 4px;
                font-size: 0.9rem;
                margin: 0.5rem 0;
                text-align: center;
                font-style: italic;
            }
            
            @media (max-width: 992px) {
                .content-wrapper {
                    flex-direction: column;
                }
                
                .player-wrapper {
                    flex: none;
                    width: 100%;
                }
                
                .chat-container {
                    width: 100%;
                    height: 500px;
                    flex: none;
                }
                
                .chat-messages {
                    min-height: 250px;
                    height: 250px;
                    max-height: 250px;
                }
            }
        `;

        // Add Socket.io client script to the existing scripts
        const socketScript = `
            <script src="/socket.io/socket.io.js"></script>
            <script>
                // Connect to Socket.io server with appropriate options for production
                const socket = io(window.location.origin, {
                    path: '/socket.io',
                    transports: ['websocket', 'polling'],
                    reconnection: true,
                    reconnectionAttempts: 5,
                    reconnectionDelay: 1000
                });
                
                // Store the chat room ID - format is source-id (matching the server-side format)
                const chatRoom = '${source}-${id}';
                console.log('Chat room ID:', chatRoom);
                
                // Debug connection issues
                socket.on('connect', () => {
                    console.log('Connected to chat server with ID:', socket.id);
                    
                    // Join the specific chat room for this stream after connection
                    console.log('Joining chat room:', chatRoom);
                    socket.emit('join room', chatRoom);
                });
                
                socket.on('connect_error', (error) => {
                    console.error('Connection error:', error);
                    chatMessages.innerHTML = '<div class="chat-loading">Failed to connect to chat. Please refresh the page.</div>';
                });
                
                // Get chat DOM elements
                const chatMessages = document.getElementById('chat-messages');
                const messageInput = document.getElementById('message-input');
                const usernameInput = document.getElementById('username-input');
                const setUsernameBtn = document.getElementById('set-username');
                const sendButton = document.getElementById('send-button');
                const viewerCountElement = document.getElementById('viewer-count');
                const toggleChatBtn = document.getElementById('toggle-chat');
                const chatContainer = document.getElementById('chat-container');
                const adminLoginBtn = document.getElementById('admin-login-btn');
                const pinnedMessageContainer = document.getElementById('pinned-message-container');
                
                // Clear loading message once connected
                chatMessages.innerHTML = '';
                
                // Track admin status
                let isAdmin = false;
                
                // Handle chat toggle
                toggleChatBtn.addEventListener('click', () => {
                    const messagesVisible = chatMessages.style.display !== 'none';
                    
                    if (messagesVisible) {
                        // Hide chat messages and input form
                        chatMessages.style.display = 'none';
                        document.querySelector('.username-selection').style.display = 'none';
                        document.querySelector('.chat-form').style.display = 'none';
                        document.querySelector('.admin-section').style.display = 'none';
                        pinnedMessageContainer.style.display = 'none';
                        toggleChatBtn.textContent = 'Show Chat';
                    } else {
                        // Show chat messages and input form
                        chatMessages.style.display = 'flex';
                        document.querySelector('.username-selection').style.display = 'flex';
                        document.querySelector('.chat-form').style.display = 'flex';
                        document.querySelector('.admin-section').style.display = 'block';
                        // Only show pinned message container if there's a pinned message
                        if (pinnedMessageContainer.innerHTML !== '') {
                            pinnedMessageContainer.style.display = 'block';
                        }
                        toggleChatBtn.textContent = 'Hide Chat';
                    }
                });
                
                // Handle admin login button
                adminLoginBtn.addEventListener('click', () => {
                    if (isAdmin) {
                        // Already logged in, do nothing
                        return;
                    }
                    
                    const code = prompt('Enter admin code:');
                    if (code) {
                        // Send the code as a chat message (will be handled specially on the server)
                        socket.emit('chat message', {
                            room: chatRoom,
                            message: code,
                            username: username,
                            color: userColor
                        });
                    }
                });
                
                // Handle admin auth confirmation
                socket.on('admin auth', (data) => {
                    if (data.success) {
                        isAdmin = true;
                        adminLoginBtn.classList.add('active');
                        adminLoginBtn.textContent = 'Admin ✓';
                        
                        // Show admin message
                        const messageElement = document.createElement('div');
                        messageElement.className = 'chat-message';
                        messageElement.innerHTML = '<span style="color: #888;">You are now logged in as <b style="color: #e50914;">Admin</b>. Use /ban [IP] to ban users.</span>';
                        chatMessages.appendChild(messageElement);
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                        
                        // Update the message display to show all messages with admin features
                        // - Make other usernames clickable for banning
                        // - Add admin badge to the current user's messages
                        const usernameElements = document.querySelectorAll('.chat-username');
                        usernameElements.forEach(element => {
                            // If this is the current user's username, add admin badge
                            if (element.textContent.startsWith(username + ':')) {
                                element.innerHTML = username + '<span class="admin-badge">ADMIN</span>:';
                            } 
                            // For other usernames, make them clickable for banning
                            else if (!element.innerHTML.includes('ADMIN')) {
                                const otherUsername = element.textContent.replace(':', '');
                                element.classList.add('clickable-username');
                                element.setAttribute('data-username', otherUsername);
                                element.title = 'Click to ban user';
                                
                                // Add click event to ban this user
                                element.addEventListener('click', function() {
                                    if (confirm('Ban user ' + otherUsername + '?')) {
                                        socket.emit('ban user', {
                                            username: otherUsername,
                                            room: chatRoom
                                        });
                                    }
                                });
                            }
                        });
                    }
                });
                
                // Handle banned notification
                socket.on('banned', () => {
                    chatMessages.innerHTML = '<div class="chat-loading">You have been banned from this chat.</div>';
                    messageInput.disabled = true;
                    sendButton.disabled = true;
                    usernameInput.disabled = true;
                    setUsernameBtn.disabled = true;
                });
                
                // Listen for viewer count updates
                socket.on('viewer count', (data) => {
                    console.log('Viewer count updated:', data.count);
                    // Update the viewer count display
                    viewerCountElement.textContent = data.count + (data.count === 1 ? ' viewer' : ' viewers');
                });
                
                // Create a random username color from a pleasing set of colors
                const colors = [
                    '#e91e63', // Pink
                    '#9c27b0', // Purple
                    '#3f51b5', // Indigo
                    '#2196f3', // Blue
                    '#03a9f4', // Light Blue
                    '#00bcd4', // Cyan
                    '#009688', // Teal
                    '#4caf50', // Green
                    '#ff9800', // Orange
                    '#ff5722'  // Deep Orange
                ];
                
                // Get a random color for this user that persists during their session
                const userColor = colors[Math.floor(Math.random() * colors.length)];
                
                // Generate default username
                let username = 'User' + Math.floor(Math.random() * 10000);
                
                // Handle setting username
                setUsernameBtn.addEventListener('click', setUsername);
                usernameInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        setUsername();
                    }
                });
                
                function setUsername() {
                    const newUsername = usernameInput.value.trim();
                    if (newUsername) {
                        // Validate username for banned words first
                        socket.emit('validate username', { username: newUsername });
                    }
                }
                
                // Handle username validation result
                socket.on('username validation', (data) => {
                    if (data.valid) {
                        // Set the username if valid
                        username = usernameInput.value.trim();
                        
                        // Display confirmation message in chat
                        const messageElement = document.createElement('div');
                        messageElement.className = 'chat-message';
                        messageElement.innerHTML = '<span style="color: #888;">You are now chatting as <b style="color: ' + userColor + ';">' + username + '</b></span>';
                        chatMessages.appendChild(messageElement);
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    } else {
                        // Show error for invalid username
                        alert(data.message);
                        usernameInput.focus();
                    }
                });
                
                // Display chat history when received
                socket.on('chat history', (messages) => {
                    console.log('Received chat history:', messages.length, 'messages');
                    chatMessages.innerHTML = ''; // Clear chat
                    messages.forEach(msg => addMessageToChat(msg));
                    chatMessages.scrollTop = chatMessages.scrollHeight; // Scroll to bottom
                });
                
                // Listen for new chat messages
                socket.on('chat message', (msg) => {
                    console.log('Received new message:', msg);
                    addMessageToChat(msg);
                    chatMessages.scrollTop = chatMessages.scrollHeight; // Scroll to bottom
                });
                
                // Listen for chat cleared event
                socket.on('chat cleared', (messages) => {
                    console.log('Chat cleared, received', messages.length, 'messages');
                    chatMessages.innerHTML = ''; // Clear the chat area
                    messages.forEach(msg => addMessageToChat(msg)); // Add the new messages
                    chatMessages.scrollTop = chatMessages.scrollHeight; // Scroll to bottom
                });
                
                // Flag to prevent double message sending
                let isSending = false;
                
                // Send message when button is clicked
                sendButton.addEventListener('click', sendMessage);
                
                // Send message when Enter key is pressed in the input
                messageInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        sendMessage();
                    }
                });
                
                // Function to send a message
                function sendMessage() {
                    const message = messageInput.value.trim();
                    
                    // Don't send if already sending or message is empty
                    if (isSending || !message) return;
                    
                    // Set flag to prevent double sending
                    isSending = true;
                    
                    // Prepare message data
                    const messageData = {
                        room: chatRoom,
                        message: message,
                        username: username,
                        color: userColor
                    };
                    
                    console.log('Sending message:', messageData);
                    
                    // Emit the message event
                    socket.emit('chat message', messageData);
                    
                    messageInput.value = ''; // Clear input after sending
                    
                    // Reset the flag after a short delay
                    setTimeout(() => {
                        isSending = false;
                    }, 500);
                }
                
                // Function to add a message to the chat
                function addMessageToChat(msg) {
                    const messageElement = document.createElement('div');
                    messageElement.className = 'chat-message';
                    
                    // Handle system messages differently
                    if (msg.isSystem) {
                        messageElement.innerHTML = '<div class="system-message">' + msg.message + '</div>';
                        messageElement.style.textAlign = 'center';
                    } else {
                        // Create username span
                        const usernameSpan = document.createElement('span');
                        usernameSpan.className = 'chat-username';
                        
                        // Add username with admin badge if applicable
                        if (msg.isAdmin) {
                            usernameSpan.innerHTML = msg.username + '<span class="admin-badge">ADMIN</span>:';
                        } else {
                            usernameSpan.textContent = msg.username + ':';
                            
                            // Make username clickable if current user is admin
                            // But don't make the admin's own username clickable
                            if (isAdmin && username !== msg.username) {
                                usernameSpan.classList.add('clickable-username');
                                usernameSpan.setAttribute('data-username', msg.username);
                                usernameSpan.title = 'Click to ban user';
                                
                                // Add click event to ban this user
                                usernameSpan.addEventListener('click', function() {
                                    if (confirm('Ban user ' + msg.username + '?')) {
                                        socket.emit('ban user', {
                                            username: msg.username,
                                            room: chatRoom
                                        });
                                    }
                                });
                            }
                        }
                        
                        // Set the color for the username
                        usernameSpan.style.color = msg.color || userColor;
                        
                        // Create message content span
                        const contentSpan = document.createElement('span');
                        contentSpan.className = msg.filtered ? 'chat-message-content filtered-message' : 'chat-message-content';
                        contentSpan.textContent = ' ' + msg.message;
                        
                        // Add elements to the message container
                        messageElement.appendChild(usernameSpan);
                        messageElement.appendChild(contentSpan);
                    }
                    
                    // Add message to chat
                    chatMessages.appendChild(messageElement);
                    
                    // Auto-scroll to the bottom when new messages arrive
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }

                // Handle admin error messages
                socket.on('admin error', (data) => {
                    alert(data.message);
                });

                // Handle pinned message
                socket.on('pinned message', (message) => {
                    // Create the pinned message UI
                    pinnedMessageContainer.innerHTML = 
                        '<div class="pinned-message-header">' +
                            '<div class="pinned-message-icon">' +
                                '<span class="pin-icon">📌</span>' +
                                '<span>Pinned message</span>' +
                            '</div>' +
                            (isAdmin ? '<button class="unpin-button" onclick="unpinMessage()">×</button>' : '') +
                        '</div>' +
                        '<div class="pinned-message-content">' +
                            '<span class="pinned-username" style="color: ' + message.color + '">' + message.username + '</span>' +
                            '<span>' + message.message + '</span>' +
                        '</div>';
                    
                    // Show the pinned message container
                    pinnedMessageContainer.style.display = 'block';
                });
                
                // Handle unpinned message
                socket.on('unpinned message', () => {
                    // Clear and hide the pinned message container
                    pinnedMessageContainer.innerHTML = '';
                    pinnedMessageContainer.style.display = 'none';
                });
                
                // Global function to unpin a message
                window.unpinMessage = function() {
                    socket.emit('unpin message', { room: chatRoom });
                };
                
                // Handle admin auth confirmation
                socket.on('admin auth', (data) => {
                    if (data.success) {
                        isAdmin = true;
                        adminLoginBtn.classList.add('active');
                        adminLoginBtn.textContent = 'Admin ✓';
                        
                        // Show admin message
                        const messageElement = document.createElement('div');
                        messageElement.className = 'chat-message';
                        messageElement.innerHTML = '<span style="color: #888;">You are now logged in as <b style="color: #e50914;">Admin</b>. Use /ban [IP] to ban users.</span>';
                        chatMessages.appendChild(messageElement);
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                        
                        // Add unpin button to pinned message if one exists
                        if (pinnedMessageContainer.style.display !== 'none') {
                            const header = pinnedMessageContainer.querySelector('.pinned-message-header');
                            if (header && !header.querySelector('.unpin-button')) {
                                header.innerHTML += '<button class="unpin-button" onclick="unpinMessage()">×</button>';
                            }
                        }
                        
                        // Update the message display to show all messages with admin features
                        // - Make other usernames clickable for banning
                        // - Add admin badge to the current user's messages
                        const usernameElements = document.querySelectorAll('.chat-username');
                        usernameElements.forEach(element => {
                            // If this is the current user's username, add admin badge
                            if (element.textContent.startsWith(username + ':')) {
                                element.innerHTML = username + '<span class="admin-badge">ADMIN</span>:';
                            } 
                            // For other usernames, make them clickable for banning
                            else if (!element.innerHTML.includes('ADMIN')) {
                                const otherUsername = element.textContent.replace(':', '');
                                element.classList.add('clickable-username');
                                element.setAttribute('data-username', otherUsername);
                                element.title = 'Click to ban user';
                                
                                // Add click event to ban this user
                                element.addEventListener('click', function() {
                                    if (confirm('Ban user ' + otherUsername + '?')) {
                                        socket.emit('ban user', {
                                            username: otherUsername,
                                            room: chatRoom
                                        });
                                    }
                                });
                            }
                        });
                        
                        // Add pin button to all messages
                        const allMessages = document.querySelectorAll('.chat-message');
                        allMessages.forEach(message => {
                            if (!message.querySelector('.message-actions') && 
                                !message.innerHTML.includes('You are now logged in as') && 
                                !message.querySelector('.system-message')) {
                                
                                addPinButtonToMessage(message);
                            }
                        });
                    }
                });
                
                // Handle admin message (for confirmations)
                socket.on('admin message', (data) => {
                    console.log('Admin message:', data.message);
                });

                // Function to add a message to the chat
                function addMessageToChat(msg) {
                    const messageElement = document.createElement('div');
                    messageElement.className = 'chat-message';
                    // Store the message ID for pinning
                    messageElement.setAttribute('data-message-id', msg.id);
                    
                    // Handle system messages differently
                    if (msg.isSystem) {
                        messageElement.innerHTML = '<div class="system-message">' + msg.message + '</div>';
                        messageElement.style.textAlign = 'center';
                    } else {
                        // Create username span
                        const usernameSpan = document.createElement('span');
                        usernameSpan.className = 'chat-username';
                        
                        // Add username with admin badge if applicable
                        if (msg.isAdmin) {
                            usernameSpan.innerHTML = msg.username + '<span class="admin-badge">ADMIN</span>:';
                        } else {
                            usernameSpan.textContent = msg.username + ':';
                            
                            // Make username clickable if current user is admin
                            // But don't make the admin's own username clickable
                            if (isAdmin && username !== msg.username) {
                                usernameSpan.classList.add('clickable-username');
                                usernameSpan.setAttribute('data-username', msg.username);
                                usernameSpan.title = 'Click to ban user';
                                
                                // Add click event to ban this user
                                usernameSpan.addEventListener('click', function() {
                                    if (confirm('Ban user ' + msg.username + '?')) {
                                        socket.emit('ban user', {
                                            username: msg.username,
                                            room: chatRoom
                                        });
                                    }
                                });
                            }
                        }
                        
                        // Set the color for the username
                        usernameSpan.style.color = msg.color || userColor;
                        
                        // Create message content span
                        const contentSpan = document.createElement('span');
                        
                        // Set appropriate class based on message state (filtered, deleted, etc.)
                        if (msg.filtered) {
                            contentSpan.className = 'chat-message-content filtered-message';
                        } else if (msg.deleted) {
                            contentSpan.className = 'chat-message-content deleted-message';
                        } else {
                            contentSpan.className = 'chat-message-content';
                        }
                        
                        contentSpan.textContent = ' ' + msg.message;
                        
                        // Add elements to the message container
                        messageElement.appendChild(usernameSpan);
                        messageElement.appendChild(contentSpan);
                        
                        // Add pin/delete buttons if admin and message is not already deleted or filtered
                        if (isAdmin && !msg.filtered && !msg.deleted) {
                            addPinButtonToMessage(messageElement);
                        }
                    }
                    
                    // Add message to chat
                    chatMessages.appendChild(messageElement);
                    
                    // Auto-scroll to the bottom when new messages arrive
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
                
                // Function to add pin button to a message
                function addPinButtonToMessage(messageElement) {
                    // Only add if not already present
                    if (!messageElement.querySelector('.message-actions')) {
                        const messageId = messageElement.getAttribute('data-message-id');
                        
                        // Create the action buttons container
                        const actionsDiv = document.createElement('div');
                        actionsDiv.className = 'message-actions';
                        
                        // Create pin button
                        const pinButton = document.createElement('button');
                        pinButton.className = 'pin-message-btn';
                        pinButton.innerHTML = '📌';
                        pinButton.title = 'Pin message';
                        pinButton.onclick = function(e) {
                            e.stopPropagation();
                            socket.emit('pin message', {
                                messageId: messageId,
                                room: chatRoom,
                                username: username
                            });
                        };
                        
                        // Create delete button
                        const deleteButton = document.createElement('button');
                        deleteButton.className = 'delete-message-btn';
                        deleteButton.innerHTML = '🗑️';
                        deleteButton.title = 'Delete message';
                        deleteButton.onclick = function(e) {
                            e.stopPropagation();
                            if (confirm('Delete this message?')) {
                                console.log('Delete confirmed for message ID:', messageId);
                                console.log('Sending delete_message event to server');
                                
                                // Send delete message event to server
                                socket.emit('delete message', {
                                    messageId: messageId,
                                    room: chatRoom,
                                    username: username
                                });
                            }
                        };
                        
                        // Add buttons to actions container
                        actionsDiv.appendChild(pinButton);
                        actionsDiv.appendChild(deleteButton);
                        
                        // Add actions container to message
                        messageElement.appendChild(actionsDiv);
                    }
                }

                // Handle admin error messages
                socket.on('admin error', (data) => {
                    alert(data.message);
                });

                // Listen for message deleted events
                socket.on('message deleted', (data) => {
                    console.log('Message deleted event received:', data);
                    const { messageId, deletedMessage } = data;
                    
                    // Find the message element in the DOM
                    const messageElement = document.querySelector('.chat-message[data-message-id="' + messageId + '"]');
                    console.log('Found message element:', messageElement);
                    
                    if (messageElement) {
                        // Update the content to show it's deleted
                        const contentSpan = messageElement.querySelector('.chat-message-content');
                        if (contentSpan) {
                            contentSpan.textContent = ' ' + deletedMessage.message;
                            contentSpan.className = 'chat-message-content deleted-message';
                            console.log('Updated message content to show deleted');
                        }
                        
                        // Remove any action buttons since the message is now deleted
                        const actionsDiv = messageElement.querySelector('.message-actions');
                        if (actionsDiv) {
                            actionsDiv.remove();
                            console.log('Removed action buttons');
                        }
                    } else {
                        console.log('Message element not found in DOM');
                    }
                });
                
                // Function to change the stream source
                function changeStream(embedUrl, buttonElement) {
                    // Update the iframe src
                    const iframe = document.getElementById('streamIframe');
                    if (iframe) {
                        iframe.src = embedUrl;
                        console.log('Stream changed to:', embedUrl);
                    }
                    
                    // Remove active class from all stream buttons
                    const allButtons = document.querySelectorAll('.stream-button');
                    allButtons.forEach(btn => btn.classList.remove('active'));
                    
                    // Add active class to the clicked button
                    if (buttonElement) {
                        buttonElement.classList.add('active');
                    }
                }
            </script>
        `;

        // Add the chatUI to the HTML response string
        const htmlResponse = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>${match.title} - ALLSTREAMCC.COM</title>
                <meta name="description" content="Watch ${match.title} live on AllStreamCC.com. Free live sports streaming. AllStream.cc - Your destination for live sports.">
                <meta name="keywords" content="allstream.cc, allstreamcc.com, ${match.title}, live sports, sports streaming, free sports streams, watch sports online">
                <meta property="og:title" content="${match.title} - ALLSTREAMCC.COM">
                <meta property="og:description" content="Watch ${match.title} live on AllStreamCC.com. Free live sports streaming.">
                <meta property="og:site_name" content="AllStreamCC.com">
                <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">
                <link rel="icon" href="https://th.bing.com/th/id/R.17dea5ebc20f4fd10389b4f180ae9b3d?rik=e9t%2fhvOQADZM1g&riu=http%3a%2f%2fclipart-library.com%2fimages%2f8i65B8AXT.png&ehk=ruY7nFucsGPNXtLQ6BYoDblZX0Klw15spn25fXFppPs%3d&risl=&pid=ImgRaw&r=0">
                
                <script>
                    // Function to change the stream source
                    function changeStream(embedUrl, buttonElement) {
                        // Update the iframe src
                        const iframe = document.getElementById('streamIframe');
                        if (iframe) {
                            iframe.src = embedUrl;
                            console.log('Stream changed to:', embedUrl);
                        }
                        
                        // Remove active class from all stream buttons
                        const allButtons = document.querySelectorAll('.stream-button');
                        allButtons.forEach(btn => btn.classList.remove('active'));
                        
                        // Add active class to the clicked button
                        if (buttonElement) {
                            buttonElement.classList.add('active');
                        }
                    }
                    
                    // Add event delegation for stream buttons
                    document.addEventListener('DOMContentLoaded', function() {
                        document.addEventListener('click', function(e) {
                            if (e.target.classList.contains('stream-button')) {
                                const embedUrl = e.target.getAttribute('data-embed-url');
                                changeStream(embedUrl, e.target);
                            }
                        });
                    });
                </script>
                
                <style>
                    :root {
                        --primary: #e50914;
                        --dark: #141414;
                        --darker: #000000;
                        --light: #ffffff;
                        --gray: #808080;
                        --transparent-dark: rgba(20, 20, 20, 0.7);
                    }

                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                        font-family: 'Montserrat', sans-serif;
                    }

                    body {
                        background: var(--dark);
                        color: var(--light);
                        line-height: 1.6;
                    }

                    .navbar {
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        height: 68px;
                        padding: 0 4%;
                        background: linear-gradient(180deg, var(--darker) 0%, transparent 100%);
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        z-index: 1000;
                        transition: background-color 0.3s;
                    }

                    .navbar.scrolled {
                        background: var(--darker);
                    }

                    .logo {
                        color: var(--primary);
                        text-decoration: none;
                        font-size: 1.8rem;
                        font-weight: 700;
                    }

                    .logo span {
                        color: var(--light);
                    }

                    .search-container {
                        position: relative;
                        max-width: 500px;
                        width: 100%;
                    }

                    .search-bar {
                        width: 100%;
                        padding: 10px 16px;
                        background: var(--transparent-dark);
                        border: 1px solid rgba(255, 255, 255, 0.2);
                        border-radius: 4px;
                        color: var(--light);
                        font-size: 1rem;
                    }

                    .search-bar:focus {
                        outline: none;
                        border-color: var(--light);
                    }

                    .search-button {
                        position: absolute;
                        right: 8px;
                        top: 50%;
                        transform: translateY(-50%);
                        background: var(--primary);
                        color: var(--light);
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-weight: 500;
                    }

                    .search-button:hover {
                        background: #f40612;
                    }

                    .main-content {
                        padding: 90px 4% 2rem;
                        max-width: 1400px;
                        margin: 0 auto;
                    }

                    .player-container {
                        width: 100%;
                        margin-bottom: 2rem;
                    }

                    .banner-ad-container {
                        width: 100%;
                        text-align: center;
                        margin: 1rem 0;
                        padding: 0.5rem;
                    }

                    .banner-ad {
                        max-width: 80%;
                        height: auto;
                        border-radius: 4px;
                        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                    }
                    
                    .advertisement-text {
                        text-align: center;
                        font-size: 1.5rem;
                        font-weight: 600;
                        color: #ffd700;
                        margin: 1.5rem 0;
                        padding: 1rem;
                        background: rgba(255, 215, 0, 0.1);
                        border-radius: 8px;
                        border: 2px solid #ffd700;
                        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
                    }

                    .video-wrapper {
                        position: relative;
                        width: 85%; /* Reduced from 100% to 85% */
                        aspect-ratio: 16/9;
                        background: #000;
                        border-radius: 8px;
                        overflow: hidden;
                        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
                        margin: 0 auto; /* Center it */
                    }

                    .video-iframe {
                        width: 100%;
                        height: 100%;
                        border: none;
                    }

                    .streams-container {
                        margin-top: 1.5rem;
                    }

                    .streams-title {
                        font-size: 1.2rem;
                        font-weight: 600;
                        margin-bottom: 1rem;
                        padding-bottom: 0.5rem;
                        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                    }

                    .streams-grid {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 0.5rem;
                    }

                    .stream-button {
                        background: rgba(255, 255, 255, 0.1);
                        border: 1px solid rgba(255, 255, 255, 0.2);
                        color: var(--light);
                        padding: 0.6rem 1rem;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 0.9rem;
                        transition: all 0.2s ease;
                    }

                    .stream-button:hover {
                        background: rgba(255, 255, 255, 0.2);
                    }

                    .stream-button.active {
                        background: var(--primary);
                        border-color: var(--primary);
                    }

                    .match-details {
                        margin-top: 2rem;
                        padding: 1.5rem;
                        background: rgba(0, 0, 0, 0.4);
                        border-radius: 8px;
                    }

                    .match-title {
                        font-size: 1.8rem;
                        font-weight: 700;
                        margin-bottom: 0.5rem;
                    }

                    .match-category {
                        font-size: 1rem;
                        color: var(--gray);
                        margin-bottom: 1rem;
                    }

                    .team-badges {
                        display: flex;
                        align-items: center;
                        gap: 2rem;
                        margin: 1.5rem 0;
                        justify-content: center;
                    }

                    .team {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        text-align: center;
                    }

                    .badge-container {
                        width: 80px;
                        height: 80px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin-bottom: 1rem;
                    }

                    .team-badge {
                        max-width: 100%;
                        max-height: 100%;
                        object-fit: contain;
                    }

                    .team-name {
                        font-size: 1.1rem;
                        font-weight: 600;
                    }

                    .vs {
                        font-size: 1.5rem;
                        font-weight: 700;
                        color: var(--gray);
                    }

                    .live-badge {
                        display: inline-block;
                        background: var(--primary);
                        color: var(--light);
                        padding: 0.3rem 0.8rem;
                        border-radius: 4px;
                        font-size: 0.8rem;
                        font-weight: 600;
                        margin-left: 1rem;
                        vertical-align: middle;
                    }

                    .back-button {
                        display: inline-flex;
                        align-items: center;
                        gap: 0.5rem;
                        background: rgba(255, 255, 255, 0.1);
                        border: none;
                        color: var(--light);
                        padding: 0.6rem 1.2rem;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 0.9rem;
                        margin-bottom: 1.5rem;
                        transition: background 0.2s;
                    }

                    .back-button:hover {
                        background: rgba(255, 255, 255, 0.2);
                    }

                    @media (max-width: 768px) {
                        .navbar {
                            height: auto;
                            padding: 1rem 4%;
                            flex-direction: column;
                            gap: 1rem;
                        }

                        .search-container {
                            width: 100%;
                        }

                        .main-content {
                            padding-top: 140px;
                        }

                        .team-badges {
                            gap: 1rem;
                        }

                        .badge-container {
                            width: 60px;
                            height: 60px;
                        }

                        .team-name {
                            font-size: 0.9rem;
                        }

                        .match-title {
                            font-size: 1.4rem;
                        }
                    }
                    
                    ${chatCSS}
                </style>

                <script
                  type="text/javascript"
                  src="https://pl28055385.effectivegatecpm.com/c6/d8/57/c6d857d6d0087430d0c9bd203d8b610d.js"
                ></script>
            </head>
            <body>
                <nav class="navbar">
                    <a href="/" class="logo">allstream<span>cc.com</span></a>
                    
                </nav>

                <main class="main-content">
                    <button class="back-button" onclick="location.href='/sports'">
                        ← Back to Sports
                    </button>
                   
                    <div class="content-wrapper">
                        <div class="player-wrapper">
                            <div class="stream-notice">
                                <div class="notice-content">
                                    <i class="notice-icon">⚠️</i>
                                    <span>If the stream isn't working, either the game hasn't started yet or you may need to use a VPN.</span>
                                </div>
                            </div>
                            <div class="player-container">
                                <div class="video-wrapper">
                                    <iframe id="streamIframe" class="video-iframe" src="${embedUrl}" allowfullscreen></iframe>
                                </div>
                              
                                
                                <div class="streams-container">
                                    <h3 class="streams-title">Available Streams</h3>
                                    <div class="streams-grid">
                                        ${allStreamsList}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="match-details">
                        <h1 class="match-title">
                            ${match.title}
                            <span class="live-badge">LIVE</span>
                        </h1>
                        <div class="match-category">${match.category}</div>

                        ${match.teams ? `
                        <div class="team-badges">
                            <div class="team">
                                <div class="badge-container">
                                    ${match.teams.home?.badge ? 
                                        `<img src="https://streamed.su/api/images/badge/${match.teams.home.badge}.webp" class="team-badge" alt="${match.teams.home.name}">` : 
                                        ''}
                                </div>
                                <div class="team-name">${match.teams.home?.name || ''}</div>
                            </div>
                            
                            <div class="vs">VS</div>
                            
                            <div class="team">
                                <div class="badge-container">
                                    ${match.teams.away?.badge ? 
                                        `<img src="https://streamed.su/api/images/badge/${match.teams.away.badge}.webp" class="team-badge" alt="${match.teams.away.name}">` : 
                                        ''}
                                </div>
                                <div class="team-name">${match.teams.away?.name || ''}</div>
                            </div>
                        </div>
                        ` : ''}
                    </div>
                </main>

                <div class="disclaimer-section">
                  <div class="disclaimer-content">
                    <p><strong>Contact:</strong> Please contact us through the Signal app @vookspook.26</p>
                    <p><strong>Disclaimer:</strong> We do not control any of the content posted. All content hosted is on 3rd party servers.</p>
                  </div>
                </div>
             

            </body>
            </html>
        `;

        res.send(htmlResponse);
    } catch (error) {
        console.error('Error in /watch-sport endpoint:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Stream Error - ALLSTREAMCC.COM</title>
                <meta name="description" content="Stream error on AllStreamCC.com. Visit AllStream.cc for live sports streaming.">
                <meta name="keywords" content="allstream.cc, allstreamcc.com, live sports, sports streaming">
                <meta property="og:site_name" content="AllStreamCC.com">
                <style>
                    body {
                        font-family: 'Montserrat', sans-serif;
                        background: #141414;
                        color: white;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        text-align: center;
                    }
                    .error-container {
                        max-width: 600px;
                        padding: 2rem;
                    }
                    h1 {
                        color: #e50914;
                        margin-bottom: 1rem;
                    }
                    p {
                        color: #999;
                        margin-bottom: 2rem;
                    }
                    .message {
                        background: rgba(255, 204, 0, 0.1);
                        border-left: 4px solid #fc0;
                        border-radius: 4px;
                        padding: 12px 16px;
                        margin: 20px 0;
                        text-align: left;
                        color: #e5e5e5;
                    }
                    a {
                        display: inline-block;
                        background: #e50914;
                        color: white;
                        padding: 10px 20px;
                        text-decoration: none;
                        border-radius: 4px;
                        margin-top: 10px;
                    }
                </style>

                <script
                  type="text/javascript"
                  src="https://pl28055385.effectivegatecpm.com/c6/d8/57/c6d857d6d0087430d0c9bd203d8b610d.js"
                ></script>
            </head>
            <body>
                <div class="error-container">
                    <h1>Stream Not Available</h1>
                    <p>We couldn't load the stream for this event.</p>
                    
                    <div class="message">
                        <p><strong>Possible reasons:</strong></p>
                        <ul style="margin-top: 10px; text-align: left;">
                            <li>The game hasn't started yet</li>
                            <li>The stream is temporarily unavailable</li>
                            <li>You need to use a VPN to access the content</li>
                        </ul>
                    </div>
                    
                    <a href="/sports">Go Back to Sports</a>
                </div>
      

            </body>
            </html>
        `);
    }
});

app.get('/watch-sport/:source/:id', async (req, res) => {
    try {
        const source = req.params.source;
        const id = req.params.id;
        const chatRoom = `${source}-${id}`; // Create a unique room ID from source and id

        // Fetch streams for the given source and ID
        const streamsResponse = await fetchWithHeaders(`https://streamed.su/api/stream/${source}/${id}`);
        f
        // Check if the response is ok before trying to parse JSON
        if (!streamsResponse.ok) {
            throw new Error(`API responded with status: ${streamsResponse.status}`);
        }
        
        const streams = await streamsResponse.json();

        // Check if streams array exists and has items
        if (!Array.isArray(streams) || streams.length === 0) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>No Streams Available</title>
                    <style>
                        body {
                            font-family: 'Montserrat', sans-serif;
                            background: #141414;
                            color: white;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                            text-align: center;
                        }
                        .error-container {
                            max-width: 600px;
                            padding: 2rem;
                        }
                        h1 {
                            color: #e50914;
                            margin-bottom: 1rem;
                        }
                        p {
                            color: #999;
                            margin-bottom: 2rem;
                        }
                        a {
                            display: inline-block;
                            background: #e50914;
                            color: white;
                            padding: 10px 20px;
                            text-decoration: none;
                            border-radius: 4px;
                        }
                    </style>

                <script
                  type="text/javascript"
                  src="https://pl28055385.effectivegatecpm.com/c6/d8/57/c6d857d6d0087430d0c9bd203d8b610d.js"
                ></script>
                </head>
                <body>
                    <div class="error-container">
                        <h1>No Streams Available</h1>
                        <p>We couldn't find any streams for this event. This may be because the game hasn't started yet or there are no available streaming sources.</p>
                        <a href="/sports">Go Back to Sports</a>
                    </div>
                 
                </body>
                </html>
            `);
        }

        // Fetch match details to get the title and other metadata
        const matchResponse = await fetchWithHeaders(`https://streamed.su/api/matches/live`);
        
        // Check if the response is ok before trying to parse JSON
        if (!matchResponse.ok) {
            throw new Error(`API responded with status: ${matchResponse.status}`);
        }
        
        const matches = await matchResponse.json();
        
        // Find the match with the same source and ID
        const match = matches.find(m => 
            m.sources && m.sources.some(s => s.source === source && s.id === id)
        ) || { title: 'Live Sport Event', category: 'Sports' };

        // Default to the first stream if available
        const defaultStream = streams.length > 0 ? streams[0] : null;
        const embedUrl = defaultStream ? defaultStream.embedUrl : '';
        
        // Generate streams list
        const streamsList = streams.map((stream, index) => {
            return `
                <button class="stream-button ${index === 0 ? 'active' : ''}" 
                        onclick="changeStream('${stream.embedUrl}', this)">
                    Stream ${stream.streamNo} ${stream.hd ? '(HD)' : ''} ${stream.language ? `- ${stream.language}` : ''}
                </button>
            `;
        }).join('');

        // Add the chat UI to the HTML before the closing </main> tag
        const chatUI = `
            <div class="chat-container" id="chat-container">
                <h3 class="chat-header">
                    Live Chat
                    <div class="chat-controls">
                        <span class="viewer-count" id="viewer-count">0 viewers</span>
                        <button id="toggle-chat" class="toggle-chat-btn">Hide Chat</button>
                    </div>
                </h3>
                <div id="pinned-message-container" class="pinned-message-container" style="display: none;"></div>
                <div class="chat-messages" id="chat-messages">
                    <div class="chat-loading">Loading chat...</div>
                </div>
                <div class="username-selection">
                    <input type="text" id="username-input" placeholder="Choose your username" class="username-input">
                    <button id="set-username" class="set-username-btn">Set</button>
                </div>
                <div class="chat-form">
                    <input type="text" id="message-input" placeholder="Type a message..." class="message-input">
                    <button id="send-button" class="send-button">Send</button>
                </div>
                <div class="admin-section">
                    <button id="admin-login-btn" class="admin-login-btn">Admin</button>
                </div>
            </div>
        `;

        // Add chat CSS to the style section
        const chatCSS = `
            /* Flex layout for content area on desktop */
            .content-wrapper {
                display: flex;
                flex-direction: row;
                gap: 1.5rem;
                margin-bottom: 2rem;
            }
            
            .player-wrapper {
                flex: 2;
                min-width: 0; /* Prevent flexbox from allowing overflow */
            }
            
            .stream-notice {
                background: rgba(255, 204, 0, 0.1);
                border-left: 4px solid #fc0;
                border-radius: 4px;
                padding: 12px 16px;
                margin-bottom: 16px;
                display: flex;
                align-items: center;
            }
            
            .notice-content {
                display: flex;
                align-items: center;
                color: #e5e5e5;
                font-size: 14px;
            }
            
            .notice-icon {
                font-style: normal;
                margin-right: 10px;
                font-size: 16px;
            }
            
            .chat-container {
                width: 400px;
                height: 600px; /* Fixed height */
                border-radius: 8px;
                background: #222;
                overflow: hidden;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                display: flex;
                flex-direction: column;
                flex: 1;
            }
            
            .chat-header {
                background: var(--primary);
                color: white;
                padding: 0.8rem 1.2rem;
                margin: 0;
                font-size: 1.2rem;
                font-weight: 600;
                flex-shrink: 0;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            
            .chat-controls {
                display: flex;
                align-items: center;
                gap: 0.8rem;
            }
            
            .toggle-chat-btn {
                background: rgba(0, 0, 0, 0.3);
                border: none;
                color: white;
                padding: 0.3rem 0.6rem;
                border-radius: 12px;
                cursor: pointer;
                font-size: 0.9rem;
                transition: background 0.2s;
            }
            
            .toggle-chat-btn:hover {
                background: rgba(0, 0, 0, 0.5);
            }
            
            .viewer-count {
                font-size: 0.9rem;
                background: rgba(0, 0, 0, 0.3);
                padding: 0.3rem 0.6rem;
                border-radius: 12px;
                font-weight: 400;
            }
            
            .pinned-message-container {
                background: rgba(229, 9, 20, 0.15);
                border-left: 3px solid var(--primary);
                margin: 0;
                padding: 12px;
                position: relative;
                flex-shrink: 0;
            }
            
            .pinned-message-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 0.8rem;
                color: rgba(255, 255, 255, 0.7);
                margin-bottom: 5px;
            }
            
            .pinned-message-icon {
                display: flex;
                align-items: center;
                gap: 4px;
            }
            
            .pin-icon {
                font-size: 12px;
            }
            
            .unpin-button {
                background: none;
                border: none;
                color: rgba(255, 255, 255, 0.7);
                cursor: pointer;
                font-size: 0.8rem;
                padding: 0;
                display: flex;
                align-items: center;
            }
            
            .unpin-button:hover {
                color: white;
            }
            
            .pinned-message-content {
                font-size: 0.95rem;
                color: white;
                display: flex;
                flex-direction: column;
            }
            
            .pinned-username {
                font-weight: 600;
                margin-right: 0.5rem;
            }
            
            .chat-messages {
                flex-grow: 1;
                height: 350px; /* Fixed height for message area */
                max-height: 350px; /* Ensure it doesn't grow beyond this */
                overflow-y: auto;
                padding: 1rem;
                background: #222;
                color: white;
                display: flex;
                flex-direction: column;
                scrollbar-width: thin;
                scrollbar-color: var(--primary) #333;
            }
            
            /* Custom scrollbar for Chrome, Edge, and Safari */
            .chat-messages::-webkit-scrollbar {
                width: 8px;
            }
            
            .chat-messages::-webkit-scrollbar-track {
                background: #333;
            }
            
            .chat-messages::-webkit-scrollbar-thumb {
                background-color: var(--primary);
                border-radius: 20px;
            }
            
            .chat-loading {
                text-align: center;
                color: var(--gray);
                padding: 1rem;
            }
            
            .chat-message {
                margin-bottom: 0.8rem;
                max-width: 90%;
                word-wrap: break-word;
                animation: fadeIn 0.2s ease-in;
                position: relative;
            }
            
            .message-actions {
                position: absolute;
                right: 0;
                top: 0;
                display: none;
                background: rgba(20, 20, 20, 0.7);
                border-radius: 4px;
                padding: 2px;
                display: flex;
                gap: 2px;
            }
            
            .chat-message:hover .message-actions {
                display: flex;
            }
            
            .pin-message-btn {
                background: none;
                border: none;
                color: rgba(255, 255, 255, 0.7);
                cursor: pointer;
                font-size: 0.8rem;
                padding: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                border-radius: 4px;
                transition: all 0.2s;
            }
            
            .pin-message-btn:hover {
                background: rgba(255, 255, 255, 0.2);
                color: white;
            }
            
            .delete-message-btn {
                background: none;
                border: none;
                color: rgba(255, 255, 255, 0.7);
                cursor: pointer;
                font-size: 0.8rem;
                padding: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                border-radius: 4px;
                transition: all 0.2s;
            }
            
            .delete-message-btn:hover {
                background: rgba(229, 9, 20, 0.4);
                color: white;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(5px); }
                to { opacity: 1; transform: translateY(0); }
            }
            
            .chat-username {
                font-weight: 600;
                margin-right: 0.5rem;
            }
            
            .clickable-username {
                cursor: pointer;
                text-decoration: underline;
                text-decoration-style: dotted;
                text-decoration-thickness: 1px;
                text-underline-offset: 3px;
            }
            
            .clickable-username:hover {
                text-decoration-style: solid;
            }
            
            .admin-badge {
                background-color: var(--primary);
                color: white;
                font-size: 0.7rem;
                padding: 0.1rem 0.3rem;
                border-radius: 4px;
                margin-left: 0.3rem;
                vertical-align: middle;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(5px); }
                to { opacity: 1; transform: translateY(0); }
            }
            
            .send-button:hover {
                background: #c7000a;
            }
            
            .admin-section {
                text-align: center;
                padding: 0.5rem;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                background: #1a1a1a;
            }
            
            .admin-login-btn {
                background: transparent;
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: rgba(255, 255, 255, 0.6);
                padding: 0.3rem 0.8rem;
                border-radius: 4px;
                cursor: pointer;
                font-size: 0.8rem;
                transition: all 0.2s;
            }
            
            .admin-login-btn:hover {
                background: rgba(255, 255, 255, 0.1);
                color: rgba(255, 255, 255, 0.8);
            }
            
            .admin-login-btn.active {
                background: var(--primary);
                color: white;
                border-color: var(--primary);
            }
            
            .username-selection {
                display: flex;
                padding: 0.8rem;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                background: #1a1a1a;
                flex-shrink: 0;
            }
            
            .username-input {
                flex-grow: 1;
                padding: 0.6rem 1rem;
                border: none;
                background: rgba(255, 255, 255, 0.1);
                color: white;
                border-radius: 4px 0 0 4px;
            }
            
            .set-username-btn {
                padding: 0.6rem 1rem;
                border: none;
                border-radius: 0 4px 4px 0;
                background: #444;
                color: white;
                cursor: pointer;
                font-weight: 500;
                transition: background 0.2s;
            }
            
            .set-username-btn:hover {
                background: #555;
            }
            
            .chat-form {
                display: flex;
                padding: 0.8rem;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                background: #1a1a1a;
                flex-shrink: 0;
            }
            
            .message-input {
                flex-grow: 1;
                padding: 0.6rem 1rem;
                border: none;
                background: rgba(255, 255, 255, 0.1);
                color: white;
                border-radius: 4px 0 0 4px;
            }
            
            .send-button {
                padding: 0.6rem 1.2rem;
                border: none;
                border-radius: 0 4px 4px 0;
                background: var(--primary);
                color: white;
                cursor: pointer;
                font-weight: 500;
            }
            
            .send-button:hover {
                background: #f40612;
            }
            
            .chat-message-content {
                display: inline;
            }
            
            .filtered-message {
                color: #888;
                font-style: italic;
            }
            
            .deleted-message {
                color: #888;
                font-style: italic;
                text-decoration: line-through;
                opacity: 0.8;
            }
            
            .system-message {
                background: rgba(0, 0, 0, 0.2);
                color: #aaa;
                padding: 8px 12px;
                border-radius: 4px;
                font-size: 0.9rem;
                margin: 0.5rem 0;
                text-align: center;
                font-style: italic;
            }
            
            @media (max-width: 992px) {
                .content-wrapper {
                    flex-direction: column;
                }
                
                .player-wrapper {
                    flex: none;
                    width: 100%;
                }
                
                .chat-container {
                    width: 100%;
                    height: 500px;
                    flex: none;
                }
                
                .chat-messages {
                    min-height: 250px;
                    height: 250px;
                    max-height: 250px;
                }
            }
        `;

        // Add Socket.io client script to the existing scripts
        const socketScript = `
            <script src="/socket.io/socket.io.js"></script>
            <script>
                // Connect to Socket.io server with appropriate options for production
                const socket = io(window.location.origin, {
                    path: '/socket.io',
                    transports: ['websocket', 'polling'],
                    reconnection: true,
                    reconnectionAttempts: 5,
                    reconnectionDelay: 1000
                });
                
                // Store the chat room ID - format is source-id (matching the server-side format)
                const chatRoom = '${source}-${id}';
                console.log('Chat room ID:', chatRoom);
                
                // Debug connection issues
                socket.on('connect', () => {
                    console.log('Connected to chat server with ID:', socket.id);
                    
                    // Join the specific chat room for this stream after connection
                    console.log('Joining chat room:', chatRoom);
                    socket.emit('join room', chatRoom);
                });
                
                socket.on('connect_error', (error) => {
                    console.error('Connection error:', error);
                    chatMessages.innerHTML = '<div class="chat-loading">Failed to connect to chat. Please refresh the page.</div>';
                });
                
                // Get chat DOM elements
                const chatMessages = document.getElementById('chat-messages');
                const messageInput = document.getElementById('message-input');
                const usernameInput = document.getElementById('username-input');
                const setUsernameBtn = document.getElementById('set-username');
                const sendButton = document.getElementById('send-button');
                const viewerCountElement = document.getElementById('viewer-count');
                const toggleChatBtn = document.getElementById('toggle-chat');
                const chatContainer = document.getElementById('chat-container');
                const adminLoginBtn = document.getElementById('admin-login-btn');
                const pinnedMessageContainer = document.getElementById('pinned-message-container');
                
                // Clear loading message once connected
                chatMessages.innerHTML = '';
                
                // Track admin status
                let isAdmin = false;
                
                // Handle chat toggle
                toggleChatBtn.addEventListener('click', () => {
                    const messagesVisible = chatMessages.style.display !== 'none';
                    
                    if (messagesVisible) {
                        // Hide chat messages and input form
                        chatMessages.style.display = 'none';
                        document.querySelector('.username-selection').style.display = 'none';
                        document.querySelector('.chat-form').style.display = 'none';
                        document.querySelector('.admin-section').style.display = 'none';
                        pinnedMessageContainer.style.display = 'none';
                        toggleChatBtn.textContent = 'Show Chat';
                    } else {
                        // Show chat messages and input form
                        chatMessages.style.display = 'flex';
                        document.querySelector('.username-selection').style.display = 'flex';
                        document.querySelector('.chat-form').style.display = 'flex';
                        document.querySelector('.admin-section').style.display = 'block';
                        // Only show pinned message container if there's a pinned message
                        if (pinnedMessageContainer.innerHTML !== '') {
                            pinnedMessageContainer.style.display = 'block';
                        }
                        toggleChatBtn.textContent = 'Hide Chat';
                    }
                });
                
                // Handle admin login button
                adminLoginBtn.addEventListener('click', () => {
                    if (isAdmin) {
                        // Already logged in, do nothing
                        return;
                    }
                    
                    const code = prompt('Enter admin code:');
                    if (code) {
                        // Send the code as a chat message (will be handled specially on the server)
                        socket.emit('chat message', {
                            room: chatRoom,
                            message: code,
                            username: username,
                            color: userColor
                        });
                    }
                });
                
                // Handle admin auth confirmation
                socket.on('admin auth', (data) => {
                    if (data.success) {
                        isAdmin = true;
                        adminLoginBtn.classList.add('active');
                        adminLoginBtn.textContent = 'Admin ✓';
                        
                        // Show admin message
                        const messageElement = document.createElement('div');
                        messageElement.className = 'chat-message';
                        messageElement.innerHTML = '<span style="color: #888;">You are now logged in as <b style="color: #e50914;">Admin</b>. Use /ban [IP] to ban users.</span>';
                        chatMessages.appendChild(messageElement);
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                        
                        // Update the message display to show all messages with admin features
                        // - Make other usernames clickable for banning
                        // - Add admin badge to the current user's messages
                        const usernameElements = document.querySelectorAll('.chat-username');
                        usernameElements.forEach(element => {
                            // If this is the current user's username, add admin badge
                            if (element.textContent.startsWith(username + ':')) {
                                element.innerHTML = username + '<span class="admin-badge">ADMIN</span>:';
                            } 
                            // For other usernames, make them clickable for banning
                            else if (!element.innerHTML.includes('ADMIN')) {
                                const otherUsername = element.textContent.replace(':', '');
                                element.classList.add('clickable-username');
                                element.setAttribute('data-username', otherUsername);
                                element.title = 'Click to ban user';
                                
                                // Add click event to ban this user
                                element.addEventListener('click', function() {
                                    if (confirm('Ban user ' + otherUsername + '?')) {
                                        socket.emit('ban user', {
                                            username: otherUsername,
                                            room: chatRoom
                                        });
                                    }
                                });
                            }
                        });
                    }
                });
                
                // Handle banned notification
                socket.on('banned', () => {
                    chatMessages.innerHTML = '<div class="chat-loading">You have been banned from this chat.</div>';
                    messageInput.disabled = true;
                    sendButton.disabled = true;
                    usernameInput.disabled = true;
                    setUsernameBtn.disabled = true;
                });
                
                // Listen for viewer count updates
                socket.on('viewer count', (data) => {
                    console.log('Viewer count updated:', data.count);
                    // Update the viewer count display
                    viewerCountElement.textContent = data.count + (data.count === 1 ? ' viewer' : ' viewers');
                });
                
                // Create a random username color from a pleasing set of colors
                const colors = [
                    '#e91e63', // Pink
                    '#9c27b0', // Purple
                    '#3f51b5', // Indigo
                    '#2196f3', // Blue
                    '#03a9f4', // Light Blue
                    '#00bcd4', // Cyan
                    '#009688', // Teal
                    '#4caf50', // Green
                    '#ff9800', // Orange
                    '#ff5722'  // Deep Orange
                ];
                
                // Get a random color for this user that persists during their session
                const userColor = colors[Math.floor(Math.random() * colors.length)];
                
                // Generate default username
                let username = 'User' + Math.floor(Math.random() * 10000);
                
                // Handle setting username
                setUsernameBtn.addEventListener('click', setUsername);
                usernameInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        setUsername();
                    }
                });
                
                function setUsername() {
                    const newUsername = usernameInput.value.trim();
                    if (newUsername) {
                        // Validate username for banned words first
                        socket.emit('validate username', { username: newUsername });
                    }
                }
                
                // Handle username validation result
                socket.on('username validation', (data) => {
                    if (data.valid) {
                        // Set the username if valid
                        username = usernameInput.value.trim();
                        
                        // Display confirmation message in chat
                        const messageElement = document.createElement('div');
                        messageElement.className = 'chat-message';
                        messageElement.innerHTML = '<span style="color: #888;">You are now chatting as <b style="color: ' + userColor + ';">' + username + '</b></span>';
                        chatMessages.appendChild(messageElement);
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    } else {
                        // Show error for invalid username
                        alert(data.message);
                        usernameInput.focus();
                    }
                });
                
                // Display chat history when received
                socket.on('chat history', (messages) => {
                    console.log('Received chat history:', messages.length, 'messages');
                    chatMessages.innerHTML = ''; // Clear chat
                    messages.forEach(msg => addMessageToChat(msg));
                    chatMessages.scrollTop = chatMessages.scrollHeight; // Scroll to bottom
                });
                
                // Listen for new chat messages
                socket.on('chat message', (msg) => {
                    console.log('Received new message:', msg);
                    addMessageToChat(msg);
                    chatMessages.scrollTop = chatMessages.scrollHeight; // Scroll to bottom
                });
                
                // Listen for chat cleared event
                socket.on('chat cleared', (messages) => {
                    console.log('Chat cleared, received', messages.length, 'messages');
                    chatMessages.innerHTML = ''; // Clear the chat area
                    messages.forEach(msg => addMessageToChat(msg)); // Add the new messages
                    chatMessages.scrollTop = chatMessages.scrollHeight; // Scroll to bottom
                });
                
                // Flag to prevent double message sending
                let isSending = false;
                
                // Send message when button is clicked
                sendButton.addEventListener('click', sendMessage);
                
                // Send message when Enter key is pressed in the input
                messageInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        sendMessage();
                    }
                });
                
                // Function to send a message
                function sendMessage() {
                    const message = messageInput.value.trim();
                    
                    // Don't send if already sending or message is empty
                    if (isSending || !message) return;
                    
                    // Set flag to prevent double sending
                    isSending = true;
                    
                    // Prepare message data
                    const messageData = {
                        room: chatRoom,
                        message: message,
                        username: username,
                        color: userColor
                    };
                    
                    console.log('Sending message:', messageData);
                    
                    // Emit the message event
                    socket.emit('chat message', messageData);
                    
                    messageInput.value = ''; // Clear input after sending
                    
                    // Reset the flag after a short delay
                    setTimeout(() => {
                        isSending = false;
                    }, 500);
                }
                
                // Function to add a message to the chat
                function addMessageToChat(msg) {
                    const messageElement = document.createElement('div');
                    messageElement.className = 'chat-message';
                    
                    // Handle system messages differently
                    if (msg.isSystem) {
                        messageElement.innerHTML = '<div class="system-message">' + msg.message + '</div>';
                        messageElement.style.textAlign = 'center';
                    } else {
                        // Create username span
                        const usernameSpan = document.createElement('span');
                        usernameSpan.className = 'chat-username';
                        
                        // Add username with admin badge if applicable
                        if (msg.isAdmin) {
                            usernameSpan.innerHTML = msg.username + '<span class="admin-badge">ADMIN</span>:';
                        } else {
                            usernameSpan.textContent = msg.username + ':';
                            
                            // Make username clickable if current user is admin
                            // But don't make the admin's own username clickable
                            if (isAdmin && username !== msg.username) {
                                usernameSpan.classList.add('clickable-username');
                                usernameSpan.setAttribute('data-username', msg.username);
                                usernameSpan.title = 'Click to ban user';
                                
                                // Add click event to ban this user
                                usernameSpan.addEventListener('click', function() {
                                    if (confirm('Ban user ' + msg.username + '?')) {
                                        socket.emit('ban user', {
                                            username: msg.username,
                                            room: chatRoom
                                        });
                                    }
                                });
                            }
                        }
                        
                        // Set the color for the username
                        usernameSpan.style.color = msg.color || userColor;
                        
                        // Create message content span
                        const contentSpan = document.createElement('span');
                        contentSpan.className = msg.filtered ? 'chat-message-content filtered-message' : 'chat-message-content';
                        contentSpan.textContent = ' ' + msg.message;
                        
                        // Add elements to the message container
                        messageElement.appendChild(usernameSpan);
                        messageElement.appendChild(contentSpan);
                    }
                    
                    // Add message to chat
                    chatMessages.appendChild(messageElement);
                    
                    // Auto-scroll to the bottom when new messages arrive
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }

                // Handle admin error messages
                socket.on('admin error', (data) => {
                    alert(data.message);
                });

                // Handle pinned message
                socket.on('pinned message', (message) => {
                    // Create the pinned message UI
                    pinnedMessageContainer.innerHTML = 
                        '<div class="pinned-message-header">' +
                            '<div class="pinned-message-icon">' +
                                '<span class="pin-icon">📌</span>' +
                                '<span>Pinned message</span>' +
                            '</div>' +
                            (isAdmin ? '<button class="unpin-button" onclick="unpinMessage()">×</button>' : '') +
                        '</div>' +
                        '<div class="pinned-message-content">' +
                            '<span class="pinned-username" style="color: ' + message.color + '">' + message.username + '</span>' +
                            '<span>' + message.message + '</span>' +
                        '</div>';
                    
                    // Show the pinned message container
                    pinnedMessageContainer.style.display = 'block';
                });
                
                // Handle unpinned message
                socket.on('unpinned message', () => {
                    // Clear and hide the pinned message container
                    pinnedMessageContainer.innerHTML = '';
                    pinnedMessageContainer.style.display = 'none';
                });
                
                // Global function to unpin a message
                window.unpinMessage = function() {
                    socket.emit('unpin message', { room: chatRoom });
                };
                
                // Handle admin auth confirmation
                socket.on('admin auth', (data) => {
                    if (data.success) {
                        isAdmin = true;
                        adminLoginBtn.classList.add('active');
                        adminLoginBtn.textContent = 'Admin ✓';
                        
                        // Show admin message
                        const messageElement = document.createElement('div');
                        messageElement.className = 'chat-message';
                        messageElement.innerHTML = '<span style="color: #888;">You are now logged in as <b style="color: #e50914;">Admin</b>. Use /ban [IP] to ban users.</span>';
                        chatMessages.appendChild(messageElement);
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                        
                        // Add unpin button to pinned message if one exists
                        if (pinnedMessageContainer.style.display !== 'none') {
                            const header = pinnedMessageContainer.querySelector('.pinned-message-header');
                            if (header && !header.querySelector('.unpin-button')) {
                                header.innerHTML += '<button class="unpin-button" onclick="unpinMessage()">×</button>';
                            }
                        }
                        
                        // Update the message display to show all messages with admin features
                        // - Make other usernames clickable for banning
                        // - Add admin badge to the current user's messages
                        const usernameElements = document.querySelectorAll('.chat-username');
                        usernameElements.forEach(element => {
                            // If this is the current user's username, add admin badge
                            if (element.textContent.startsWith(username + ':')) {
                                element.innerHTML = username + '<span class="admin-badge">ADMIN</span>:';
                            } 
                            // For other usernames, make them clickable for banning
                            else if (!element.innerHTML.includes('ADMIN')) {
                                const otherUsername = element.textContent.replace(':', '');
                                element.classList.add('clickable-username');
                                element.setAttribute('data-username', otherUsername);
                                element.title = 'Click to ban user';
                                
                                // Add click event to ban this user
                                element.addEventListener('click', function() {
                                    if (confirm('Ban user ' + otherUsername + '?')) {
                                        socket.emit('ban user', {
                                            username: otherUsername,
                                            room: chatRoom
                                        });
                                    }
                                });
                            }
                        });
                        
                        // Add pin button to all messages
                        const allMessages = document.querySelectorAll('.chat-message');
                        allMessages.forEach(message => {
                            if (!message.querySelector('.message-actions') && 
                                !message.innerHTML.includes('You are now logged in as') && 
                                !message.querySelector('.system-message')) {
                                
                                addPinButtonToMessage(message);
                            }
                        });
                    }
                });
                
                // Handle admin message (for confirmations)
                socket.on('admin message', (data) => {
                    console.log('Admin message:', data.message);
                });

                // Function to add a message to the chat
                function addMessageToChat(msg) {
                    const messageElement = document.createElement('div');
                    messageElement.className = 'chat-message';
                    // Store the message ID for pinning
                    messageElement.setAttribute('data-message-id', msg.id);
                    
                    // Handle system messages differently
                    if (msg.isSystem) {
                        messageElement.innerHTML = '<div class="system-message">' + msg.message + '</div>';
                        messageElement.style.textAlign = 'center';
                    } else {
                        // Create username span
                        const usernameSpan = document.createElement('span');
                        usernameSpan.className = 'chat-username';
                        
                        // Add username with admin badge if applicable
                        if (msg.isAdmin) {
                            usernameSpan.innerHTML = msg.username + '<span class="admin-badge">ADMIN</span>:';
                        } else {
                            usernameSpan.textContent = msg.username + ':';
                            
                            // Make username clickable if current user is admin
                            // But don't make the admin's own username clickable
                            if (isAdmin && username !== msg.username) {
                                usernameSpan.classList.add('clickable-username');
                                usernameSpan.setAttribute('data-username', msg.username);
                                usernameSpan.title = 'Click to ban user';
                                
                                // Add click event to ban this user
                                usernameSpan.addEventListener('click', function() {
                                    if (confirm('Ban user ' + msg.username + '?')) {
                                        socket.emit('ban user', {
                                            username: msg.username,
                                            room: chatRoom
                                        });
                                    }
                                });
                            }
                        }
                        
                        // Set the color for the username
                        usernameSpan.style.color = msg.color || userColor;
                        
                        // Create message content span
                        const contentSpan = document.createElement('span');
                        
                        // Set appropriate class based on message state (filtered, deleted, etc.)
                        if (msg.filtered) {
                            contentSpan.className = 'chat-message-content filtered-message';
                        } else if (msg.deleted) {
                            contentSpan.className = 'chat-message-content deleted-message';
                        } else {
                            contentSpan.className = 'chat-message-content';
                        }
                        
                        contentSpan.textContent = ' ' + msg.message;
                        
                        // Add elements to the message container
                        messageElement.appendChild(usernameSpan);
                        messageElement.appendChild(contentSpan);
                        
                        // Add pin/delete buttons if admin and message is not already deleted or filtered
                        if (isAdmin && !msg.filtered && !msg.deleted) {
                            addPinButtonToMessage(messageElement);
                        }
                    }
                    
                    // Add message to chat
                    chatMessages.appendChild(messageElement);
                    
                    // Auto-scroll to the bottom when new messages arrive
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
                
                // Function to add pin button to a message
                function addPinButtonToMessage(messageElement) {
                    // Only add if not already present
                    if (!messageElement.querySelector('.message-actions')) {
                        const messageId = messageElement.getAttribute('data-message-id');
                        
                        // Create the action buttons container
                        const actionsDiv = document.createElement('div');
                        actionsDiv.className = 'message-actions';
                        
                        // Create pin button
                        const pinButton = document.createElement('button');
                        pinButton.className = 'pin-message-btn';
                        pinButton.innerHTML = '📌';
                        pinButton.title = 'Pin message';
                        pinButton.onclick = function(e) {
                            e.stopPropagation();
                            socket.emit('pin message', {
                                messageId: messageId,
                                room: chatRoom,
                                username: username
                            });
                        };
                        
                        // Create delete button
                        const deleteButton = document.createElement('button');
                        deleteButton.className = 'delete-message-btn';
                        deleteButton.innerHTML = '🗑️';
                        deleteButton.title = 'Delete message';
                        deleteButton.onclick = function(e) {
                            e.stopPropagation();
                            if (confirm('Delete this message?')) {
                                console.log('Delete confirmed for message ID:', messageId);
                                console.log('Sending delete_message event to server');
                                
                                // Send delete message event to server
                                socket.emit('delete message', {
                                    messageId: messageId,
                                    room: chatRoom,
                                    username: username
                                });
                            }
                        };
                        
                        // Add buttons to actions container
                        actionsDiv.appendChild(pinButton);
                        actionsDiv.appendChild(deleteButton);
                        
                        // Add actions container to message
                        messageElement.appendChild(actionsDiv);
                    }
                }

                // Handle admin error messages
                socket.on('admin error', (data) => {
                    alert(data.message);
                });

                // Listen for message deleted events
                socket.on('message deleted', (data) => {
                    console.log('Message deleted event received:', data);
                    const { messageId, deletedMessage } = data;
                    
                    // Find the message element in the DOM
                    const messageElement = document.querySelector('.chat-message[data-message-id="' + messageId + '"]');
                    console.log('Found message element:', messageElement);
                    
                    if (messageElement) {
                        // Update the content to show it's deleted
                        const contentSpan = messageElement.querySelector('.chat-message-content');
                        if (contentSpan) {
                            contentSpan.textContent = ' ' + deletedMessage.message;
                            contentSpan.className = 'chat-message-content deleted-message';
                            console.log('Updated message content to show deleted');
                        }
                        
                        // Remove any action buttons since the message is now deleted
                        const actionsDiv = messageElement.querySelector('.message-actions');
                        if (actionsDiv) {
                            actionsDiv.remove();
                            console.log('Removed action buttons');
                        }
                    } else {
                        console.log('Message element not found in DOM');
                    }
                });
                
                // Function to change the stream source
                function changeStream(embedUrl, buttonElement) {
                    // Update the iframe src
                    const iframe = document.getElementById('streamIframe');
                    if (iframe) {
                        iframe.src = embedUrl;
                        console.log('Stream changed to:', embedUrl);
                    }
                    
                    // Remove active class from all stream buttons
                    const allButtons = document.querySelectorAll('.stream-button');
                    allButtons.forEach(btn => btn.classList.remove('active'));
                    
                    // Add active class to the clicked button
                    if (buttonElement) {
                        buttonElement.classList.add('active');
                    }
                }
            </script>
        `;
        // Add the chatUI to the HTML response string
        const htmlResponse = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>${match.title} - ALLSTREAMCC.COM</title>
                <meta name="description" content="Watch ${match.title} live on AllStreamCC.com. Free live sports streaming. AllStream.cc - Your destination for live sports.">
                <meta name="keywords" content="allstream.cc, allstreamcc.com, ${match.title}, live sports, sports streaming, free sports streams, watch sports online">
                <meta property="og:title" content="${match.title} - ALLSTREAMCC.COM">
                <meta property="og:description" content="Watch ${match.title} live on AllStreamCC.com. Free live sports streaming.">
                <meta property="og:site_name" content="AllStreamCC.com">
                <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">
                <link rel="icon" href="https://th.bing.com/th/id/R.17dea5ebc20f4fd10389b4f180ae9b3d?rik=e9t%2fhvOQADZM1g&riu=http%3a%2f%2fclipart-library.com%2fimages%2f8i65B8AXT.png&ehk=ruY7nFucsGPNXtLQ6BYoDblZX0Klw15spn25fXFppPs%3d&risl=&pid=ImgRaw&r=0">
                
                <script>
                    // Function to change the stream source
                    function changeStream(embedUrl, buttonElement) {
                        // Update the iframe src
                        const iframe = document.getElementById('streamIframe');
                        if (iframe) {
                            iframe.src = embedUrl;
                            console.log('Stream changed to:', embedUrl);
                        }
                        
                        // Remove active class from all stream buttons
                        const allButtons = document.querySelectorAll('.stream-button');
                        allButtons.forEach(btn => btn.classList.remove('active'));
                        
                        // Add active class to the clicked button
                        if (buttonElement) {
                            buttonElement.classList.add('active');
                        }
                    }
                    
                    // Add event delegation for stream buttons
                    document.addEventListener('DOMContentLoaded', function() {
                        document.addEventListener('click', function(e) {
                            if (e.target.classList.contains('stream-button')) {
                                const embedUrl = e.target.getAttribute('data-embed-url');
                                changeStream(embedUrl, e.target);
                            }
                        });
                    });
                </script>
                
                <style>
                    :root {
                        --primary: #e50914;
                        --dark: #141414;
                        --darker: #000000;
                        --light: #ffffff;
                        --gray: #808080;
                        --transparent-dark: rgba(20, 20, 20, 0.7);
                    }

                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                        font-family: 'Montserrat', sans-serif;
                    }

                    body {
                        background: var(--dark);
                        color: var(--light);
                        line-height: 1.6;
                    }

                    .navbar {
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        height: 68px;
                        padding: 0 4%;
                        background: linear-gradient(180deg, var(--darker) 0%, transparent 100%);
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        z-index: 1000;
                        transition: background-color 0.3s;
                    }

                    .navbar.scrolled {
                        background: var(--darker);
                    }

                    .logo {
                        color: var(--primary);
                        text-decoration: none;
                        font-size: 1.8rem;
                        font-weight: 700;
                    }

                    .logo span {
                        color: var(--light);
                    }

                    .search-container {
                        position: relative;
                        max-width: 500px;
                        width: 100%;
                    }

                    .search-bar {
                        width: 100%;
                        padding: 10px 16px;
                        background: var(--transparent-dark);
                        border: 1px solid rgba(255, 255, 255, 0.2);
                        border-radius: 4px;
                        color: var(--light);
                        font-size: 1rem;
                    }

                    .search-bar:focus {
                        outline: none;
                        border-color: var(--light);
                    }

                    .search-button {
                        position: absolute;
                        right: 8px;
                        top: 50%;
                        transform: translateY(-50%);
                        background: var(--primary);
                        color: var(--light);
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-weight: 500;
                    }

                    .search-button:hover {
                        background: #f40612;
                    }

                    .main-content {
                        padding: 90px 4% 2rem;
                        max-width: 1400px;
                        margin: 0 auto;
                    }

                    .player-container {
                        width: 100%;
                        margin-bottom: 2rem;
                    }

                    .banner-ad-container {
                        width: 100%;
                        text-align: center;
                        margin: 1rem 0;
                        padding: 0.5rem;
                    }

                    .banner-ad {
                        max-width: 80%;
                        height: auto;
                        border-radius: 4px;
                        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                    }
                    
                    .advertisement-text {
                        text-align: center;
                        font-size: 1.5rem;
                        font-weight: 600;
                        color: #ffd700;
                        margin: 1.5rem 0;
                        padding: 1rem;
                        background: rgba(255, 215, 0, 0.1);
                        border-radius: 8px;
                        border: 2px solid #ffd700;
                        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
                    }

                    .video-wrapper {
                        position: relative;
                        width: 85%; /* Reduced from 100% to 85% */
                        aspect-ratio: 16/9;
                        background: #000;
                        border-radius: 8px;
                        overflow: hidden;
                        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
                        margin: 0 auto; /* Center it */
                    }

                    .video-iframe {
                        width: 100%;
                        height: 100%;
                        border: none;
                    }

                    .streams-container {
                        margin-top: 1.5rem;
                    }

                    .streams-title {
                        font-size: 1.2rem;
                        font-weight: 600;
                        margin-bottom: 1rem;
                        padding-bottom: 0.5rem;
                        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                    }

                    .streams-grid {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 0.5rem;
                    }

                    .stream-button {
                        background: rgba(255, 255, 255, 0.1);
                        border: 1px solid rgba(255, 255, 255, 0.2);
                        color: var(--light);
                        padding: 0.6rem 1rem;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 0.9rem;
                        transition: all 0.2s ease;
                    }

                    .stream-button:hover {
                        background: rgba(255, 255, 255, 0.2);
                    }

                    .stream-button.active {
                        background: var(--primary);
                        border-color: var(--primary);
                    }

                    .match-details {
                        margin-top: 2rem;
                        padding: 1.5rem;
                        background: rgba(0, 0, 0, 0.4);
                        border-radius: 8px;
                    }

                    .match-title {
                        font-size: 1.8rem;
                        font-weight: 700;
                        margin-bottom: 0.5rem;
                    }

                    .match-category {
                        font-size: 1rem;
                        color: var(--gray);
                        margin-bottom: 1rem;
                    }

                    .team-badges {
                        display: flex;
                        align-items: center;
                        gap: 2rem;
                        margin: 1.5rem 0;
                        justify-content: center;
                    }

                    .team {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        text-align: center;
                    }

                    .badge-container {
                        width: 80px;
                        height: 80px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin-bottom: 1rem;
                    }

                    .team-badge {
                        max-width: 100%;
                        max-height: 100%;
                        object-fit: contain;
                    }

                    .team-name {
                        font-size: 1.1rem;
                        font-weight: 600;
                    }

                    .vs {
                        font-size: 1.5rem;
                        font-weight: 700;
                        color: var(--gray);
                    }

                    .live-badge {
                        display: inline-block;
                        background: var(--primary);
                        color: var(--light);
                        padding: 0.3rem 0.8rem;
                        border-radius: 4px;
                        font-size: 0.8rem;
                        font-weight: 600;
                        margin-left: 1rem;
                        vertical-align: middle;
                    }

                    .back-button {
                        display: inline-flex;
                        align-items: center;
                        gap: 0.5rem;
                        background: rgba(255, 255, 255, 0.1);
                        border: none;
                        color: var(--light);
                        padding: 0.6rem 1.2rem;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 0.9rem;
                        margin-bottom: 1.5rem;
                        transition: background 0.2s;
                    }

                    .back-button:hover {
                        background: rgba(255, 255, 255, 0.2);
                    }

                    @media (max-width: 768px) {
                        .navbar {
                            height: auto;
                            padding: 1rem 4%;
                            flex-direction: column;
                            gap: 1rem;
                        }

                        .search-container {
                            width: 100%;
                        }

                        .main-content {
                            padding-top: 140px;
                        }

                        .team-badges {
                            gap: 1rem;
                        }

                        .badge-container {
                            width: 60px;
                            height: 60px;
                        }

                        .team-name {
                            font-size: 0.9rem;
                        }

                        .match-title {
                            font-size: 1.4rem;
                        }
                    }
                    
                    ${chatCSS}
                </style>

                <script
                  type="text/javascript"
                  src="https://pl28055385.effectivegatecpm.com/c6/d8/57/c6d857d6d0087430d0c9bd203d8b610d.js"
                ></script>
            </head>
            <body>
                <nav class="navbar">
                    <a href="/" class="logo">allstream<span>cc.com</span></a>
                    
                </nav>

                <main class="main-content">
                    <button class="back-button" onclick="location.href='/sports'">
                        ← Back to Sports
                    </button>
                   
                    <div class="content-wrapper">
                        <div class="player-wrapper">
                            <div class="stream-notice">
                                <div class="notice-content">
                                    <i class="notice-icon">⚠️</i>
                                    <span>If the stream isn't working, either the game hasn't started yet or you may need to use a VPN.</span>
                                </div>
                            </div>
                            <div class="player-container">
                                
                                <div class="video-wrapper">
                                    <iframe id="streamIframe" class="video-iframe" src="${embedUrl}" allowfullscreen></iframe>
                                </div>
                                
                                <div style="text-align: center; margin: 1rem 0;">
                                    <a href="https://duel.com/r/nigbert" target="_blank" rel="noopener noreferrer">
                                        <img src="/wow.png" alt="wow" style="max-width: 100%; height: auto;">
                                    </a>
                                </div>
                             
                                
                                
                                <div class="streams-container">
                                    <h3 class="streams-title">Available Streams</h3>
                                    <div class="streams-grid">
                                        ${allStreamsList}
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        ${chatUI}
                    </div>

                    <div class="match-details">
                        <h1 class="match-title">
                            ${match.title}
                            <span class="live-badge">LIVE</span>
                        </h1>
                        <div class="match-category">${match.category}</div>

                        ${match.teams ? `
                        <div class="team-badges">
                            <div class="team">
                                <div class="badge-container">
                                    ${match.teams.home?.badge ? 
                                        `<img src="https://streamed.su/api/images/badge/${match.teams.home.badge}.webp" class="team-badge" alt="${match.teams.home.name}">` : 
                                        ''}
                                </div>
                                <div class="team-name">${match.teams.home?.name || ''}</div>
                            </div>
                            
                            <div class="vs">VS</div>
                            
                            <div class="team">
                                <div class="badge-container">
                                    ${match.teams.away?.badge ? 
                                        `<img src="https://streamed.su/api/images/badge/${match.teams.away.badge}.webp" class="team-badge" alt="${match.teams.away.name}">` : 
                                        ''}
                                </div>
                                <div class="team-name">${match.teams.away?.name || ''}</div>
                            </div>
                        </div>
                        ` : ''}
                    </div>
                </main>

                <div class="disclaimer-section">
                  <div class="disclaimer-content">
                    <p><strong>Contact:</strong> Please contact us through the Signal app @vookspook.26</p>
                    <p><strong>Disclaimer:</strong> We do not control any of the content posted. All content hosted is on 3rd party servers.</p>
                  </div>
                </div>
               

            </body>
            </html>
        `;

        res.send(htmlResponse);
    } catch (error) {
        console.error('Error in /watch-sport endpoint:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Stream Error - ALLSTREAMCC.COM</title>
                <meta name="description" content="Stream error on AllStreamCC.com. Visit AllStream.cc for live sports streaming.">
                <meta name="keywords" content="allstream.cc, allstreamcc.com, live sports, sports streaming">
                <meta property="og:site_name" content="AllStreamCC.com">
                <style>
                    body {
                        font-family: 'Montserrat', sans-serif;
                        background: #141414;
                        color: white;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        text-align: center;
                    }
                    .error-container {
                        max-width: 600px;
                        padding: 2rem;
                    }
                    h1 {
                        color: #e50914;
                        margin-bottom: 1rem;
                    }
                    p {
                        color: #999;
                        margin-bottom: 2rem;
                    }
                    .message {
                        background: rgba(255, 204, 0, 0.1);
                        border-left: 4px solid #fc0;
                        border-radius: 4px;
                        padding: 12px 16px;
                        margin: 20px 0;
                        text-align: left;
                        color: #e5e5e5;
                    }
                    a {
                        display: inline-block;
                        background: #e50914;
                        color: white;
                        padding: 10px 20px;
                        text-decoration: none;
                        border-radius: 4px;
                        margin-top: 10px;
                    }
                </style>

                <script
                  type="text/javascript"
                  src="https://pl28055385.effectivegatecpm.com/c6/d8/57/c6d857d6d0087430d0c9bd203d8b610d.js"
                ></script>
            </head>
            <body>
                <div class="error-container">
                    <h1>Stream Not Available</h1>
                    <p>We couldn't load the stream for this event.</p>
                    
                    <div class="message">
                        <p><strong>Possible reasons:</strong></p>
                        <ul style="margin-top: 10px; text-align: left;">
                            <li>The game hasn't started yet</li>
                            <li>The stream is temporarily unavailable</li>
                            <li>You need to use a VPN to access the content</li>
                        </ul>
                    </div>
                    
                    <a href="/sports">Go Back to Sports</a>
                </div>
             
            </body>
            </html>
        `);
    }
});

// Add this new endpoint to display matches for a specific sport
app.get('/sports/:sportId', async (req, res) => {
    try {
        const sportId = req.params.sportId;
        
        // Fetch list of sports to get the sport name
        const sportsResponse = await fetchWithHeaders('https://streamed.su/api/sports');
        const sports = await sportsResponse.json();
        const sport = sports.find(s => s.id === sportId) || { name: 'Sport' };
        
        // Fetch popular matches for the specific sport
        const popularMatchesResponse = await fetchWithHeaders(`https://streamed.su/api/matches/${sportId}/popular`);
        const popularMatches = await popularMatchesResponse.json();
        
        // Fetch all matches for the specific sport
        const allMatchesResponse = await fetchWithHeaders(`https://streamed.su/api/matches/${sportId}`);
        const allMatches = await allMatchesResponse.json();
        
        // Filter matches to only include those with a source
        const validPopularMatches = popularMatches.filter(match => match.sources && match.sources.length > 0);
        const validAllMatches = allMatches.filter(match => match.sources && match.sources.length > 0);
        
        // Filter live matches (including popular and non-popular)
        const liveMatches = validAllMatches.filter(match => match.isLive && !validPopularMatches.some(pm => pm.id === match.id));

        // Generate HTML for popular matches
        const popularMatchesHtml = validPopularMatches.length > 0 ? `
            <div class="sport-category">
                <h2 class="category-title">Popular ${sport.name} Matches</h2>
                <div class="sport-row-container">
                    ${validPopularMatches.length > 1 ? `
                        <button class="scroll-btn scroll-left" onclick="scrollSportRow(this.closest('.sport-row-container').querySelector('.sport-row'), 'left')">&#10094;</button>
                        <button class="scroll-btn scroll-right" onclick="scrollSportRow(this.closest('.sport-row-container').querySelector('.sport-row'), 'right')">&#10095;</button>
                    ` : ''}
                    <div class="sport-row">
                        ${validPopularMatches.map(match => {
                            // Store the first server and ID for later use
                            const firstSource = match.sources[0];
                            // Get second and third sources if available, or use the first source as fallback
                            const secondSource = match.sources[1] || match.sources[0];
                            const thirdSource = match.sources[2] || match.sources[0];
                            
                            const matchTitle = match.title || 'Match';
                            const isLive = match.isLive;
                            
                            // Generate the time display
                            let timeDisplay = '';
                            if (match.startTimestamp) {
                                const matchDate = new Date(match.startTimestamp * 1000);
                                const formattedTime = matchDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                                timeDisplay = `<div class="match-time">${formattedTime}</div>`;
                            }
                            
                            // Generate the team badges if available
                            let teamBadges = '';
                            if (match.teams) {
                                teamBadges = `
                                    <div class="teams-display">
                                        <div class="team-name home-team">${match.teams.home?.name || 'Home'}</div>
                                        <div class="vs-text">VS</div>
                                        <div class="team-name away-team">${match.teams.away?.name || 'Away'}</div>
                                    </div>
                                `;
                            }

                            return `
                                <div class="match-card" 
                                     data-source="${firstSource.source}" 
                                     data-id="${firstSource.id}"
                                     onclick="location.href='/watch-sport/${firstSource.source}/${firstSource.id}/${secondSource.source}/${secondSource.id}/${thirdSource.source}/${thirdSource.id}'">
                                    <div class="match-gradient-bg ${!isLive ? 'upcoming' : ''}">
                                        <div class="match-info">
                                            <div class="match-title">${matchTitle}</div>
                                            ${teamBadges}
                                            ${timeDisplay}
                                            ${isLive ? '<div class="live-indicator">LIVE</div>' : ''}
                                            <div class="popular-indicator">POPULAR</div>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            </div>
        ` : '';

        // Generate HTML for live matches (excluding popular ones)
        const liveMatchesHtml = liveMatches.length > 0 ? `
            <div class="sport-category">
                <h2 class="category-title">Live ${sport.name} Matches</h2>
                <div class="sport-row-container">
                    ${liveMatches.length > 1 ? `
                        <button class="scroll-btn scroll-left" onclick="scrollSportRow(this.closest('.sport-row-container').querySelector('.sport-row'), 'left')">&#10094;</button>
                        <button class="scroll-btn scroll-right" onclick="scrollSportRow(this.closest('.sport-row-container').querySelector('.sport-row'), 'right')">&#10095;</button>
                    ` : ''}
                    <div class="sport-row">
                        ${liveMatches.map(match => {
                            // Store the first server and ID for later use
                            const firstSource = match.sources[0];
                            // Get second and third sources if available, or use the first source as fallback
                            const secondSource = match.sources[1] || match.sources[0];
                            const thirdSource = match.sources[2] || match.sources[0];
                            
                            const matchTitle = match.title || 'Live Match';
                            
                            // Generate the team display if available
                            let teamBadges = '';
                            if (match.teams) {
                                teamBadges = `
                                    <div class="teams-display">
                                        <div class="team-name home-team">${match.teams.home?.name || 'Home'}</div>
                                        <div class="vs-text">VS</div>
                                        <div class="team-name away-team">${match.teams.away?.name || 'Away'}</div>
                                    </div>
                                `;
                            }

                            return `
                                <div class="match-card" 
                                     data-source="${firstSource.source}" 
                                     data-id="${firstSource.id}"
                                     onclick="location.href='/watch-sport/${firstSource.source}/${firstSource.id}/${secondSource.source}/${secondSource.id}/${thirdSource.source}/${thirdSource.id}'">
                                    <div class="match-gradient-bg">
                                        <div class="match-info">
                                            <div class="match-title">${matchTitle}</div>
                                            ${teamBadges}
                                            <div class="live-indicator">LIVE</div>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            </div>
        ` : '';

        // Filter upcoming matches (not live and not popular)
        const upcomingMatches = validAllMatches.filter(match => 
            !match.isLive && !validPopularMatches.some(pm => pm.id === match.id)
        );
        
        // Group upcoming matches by date
        const groupedMatches = {};
        upcomingMatches.forEach(match => {
            if (match.startTimestamp) {
                const matchDate = new Date(match.startTimestamp * 1000);
                const dateString = matchDate.toLocaleDateString();
                
                if (!groupedMatches[dateString]) {
                    groupedMatches[dateString] = [];
                }
                
                groupedMatches[dateString].push(match);
            }
        });
        
        // Generate HTML for upcoming matches grouped by date
        const upcomingMatchesHtml = Object.keys(groupedMatches).map(dateString => {
            const matches = groupedMatches[dateString];
            
            return `
                <div class="sport-category">
                    <h2 class="category-title">${dateString}</h2>
                    <div class="sport-row-container">
                        ${matches.length > 1 ? `
                            <button class="scroll-btn scroll-left" onclick="scrollSportRow(this.closest('.sport-row-container').querySelector('.sport-row'), 'left')">&#10094;</button>
                            <button class="scroll-btn scroll-right" onclick="scrollSportRow(this.closest('.sport-row-container').querySelector('.sport-row'), 'right')">&#10095;</button>
                        ` : ''}
                        <div class="sport-row">
                            ${matches.map(match => {
                                // Store the first server and ID for later use
                                const firstSource = match.sources[0];
                                // Get second and third sources if available, or use the first source as fallback
                                const secondSource = match.sources[1] || match.sources[0];
                                const thirdSource = match.sources[2] || match.sources[0];
                                
                                const matchTitle = match.title || 'Upcoming Match';
                                
                                // Generate the time display
                                let timeDisplay = '';
                                if (match.startTimestamp) {
                                    const matchDate = new Date(match.startTimestamp * 1000);
                                    const formattedTime = matchDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                                    timeDisplay = `<div class="match-time">${formattedTime}</div>`;
                                }
                                
                                // Generate the team badges if available
                                let teamBadges = '';
                                if (match.teams) {
                                    teamBadges = `
                                        <div class="teams-display">
                                            <div class="team-name home-team">${match.teams.home?.name || 'Home'}</div>
                                            <div class="vs-text">VS</div>
                                            <div class="team-name away-team">${match.teams.away?.name || 'Away'}</div>
                                        </div>
                                    `;
                                }

                                return `
                                    <div class="match-card" 
                                         data-source="${firstSource.source}" 
                                         data-id="${firstSource.id}"
                                         onclick="location.href='/watch-sport/${firstSource.source}/${firstSource.id}/${secondSource.source}/${secondSource.id}/${thirdSource.source}/${thirdSource.id}'">
                                        <div class="match-gradient-bg upcoming">
                                            <div class="match-info">
                                                <div class="match-title">${matchTitle}</div>
                                                ${teamBadges}
                                                ${timeDisplay}
                                            </div>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>${sport.name} - ALLSTREAMCC.COM</title>
                <meta name="description" content="Watch ${sport.name} matches live on AllStreamCC.com. Free live sports streaming for ${sport.name}. AllStream.cc - Your destination for live sports.">
                <meta name="keywords" content="allstream.cc, allstreamcc.com, ${sport.name}, live sports, sports streaming, free sports streams, watch sports online">
                <meta property="og:title" content="${sport.name} - ALLSTREAMCC.COM">
                <meta property="og:description" content="Watch ${sport.name} matches live on AllStreamCC.com. Free live sports streaming.">
                <meta property="og:site_name" content="AllStreamCC.com">
                <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">
                <link rel="icon" href="https://th.bing.com/th/id/R.17dea5ebc20f4fd10389b4f180ae9b3d?rik=e9t%2fhvOQADZM1g&riu=http%3a%2f%2fclipart-library.com%2fimages%2f8i65B8AXT.png&ehk=ruY7nFucsGPNXtLQ6BYoDblZX0Klw15spn25fXFppPs%3d&risl=&pid=ImgRaw&r=0">
                <style>
                    :root {
                        --primary: #e50914;
                        --dark: #141414;
                        --darker: #000000;
                        --light: #ffffff;
                        --gray: #808080;
                        --transparent-dark: rgba(20, 20, 20, 0.7);
                    }

                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                        font-family: 'Montserrat', sans-serif;
                    }

                    body {
                        background: var(--dark);
                        color: var(--light);
                        line-height: 1.6;
                    }

                    .navbar {
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        height: 68px;
                        padding: 0 4%;
                        background: linear-gradient(180deg, var(--darker) 0%, transparent 100%);
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        z-index: 1000;
                        transition: background-color 0.3s;
                    }

                    .navbar.scrolled {
                        background: var(--darker);
                    }

                    .logo {
                        color: var(--primary);
                        text-decoration: none;
                        font-size: 1.8rem;
                        font-weight: 700;
                    }

                    .logo span {
                        color: var(--light);
                    }

                    .search-container {
                        position: relative;
                        max-width: 500px;
                        width: 100%;
                    }

                    .search-bar {
                        width: 100%;
                        padding: 10px 16px;
                        background: var(--transparent-dark);
                        border: 1px solid rgba(255, 255, 255, 0.2);
                        border-radius: 4px;
                        color: var(--light);
                        font-size: 1rem;
                    }

                    .search-bar:focus {
                        outline: none;
                        border-color: var(--light);
                    }

                    .search-button {
                        position: absolute;
                        right: 8px;
                        top: 50%;
                        transform: translateY(-50%);
                        background: var(--primary);
                        color: var(--light);
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-weight: 500;
                    }

                    .search-button:hover {
                        background: #f40612;
                    }

                    .main-content {
                        padding: 90px 4% 2rem;
                        max-width: 1400px;
                        margin: 0 auto;
                    }

                    .page-title {
                        font-size: 2.5rem;
                        font-weight: 700;
                        margin-bottom: 2rem;
                    }

                    .sport-category {
                        margin-bottom: 3rem;
                        position: relative;
                    }

                    .category-title {
                        font-size: 1.5rem;
                        font-weight: 600;
                        margin-bottom: 1rem;
                        padding-bottom: 0.5rem;
                        border-bottom: 2px solid rgba(255, 255, 255, 0.1);
                    }

                    .sport-row-container {
                        position: relative;
                        margin: 1rem 0;
                    }
                    
                    .sport-row {
                        display: flex;
                        overflow-x: auto;
                        gap: 0.5rem;
                        scroll-behavior: smooth;
                        -webkit-overflow-scrolling: touch;
                        padding: 10px 40px;  /* Add padding to make room for buttons */
                    }
                    
                    .scroll-btn {
                        position: absolute;
                        top: 50%;
                        transform: translateY(-50%);
                        background: rgba(0, 0, 0, 0.7);
                        color: white;
                        border: none;
                        border-radius: 50%;
                        width: 40px;
                        height: 40px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 1.2rem;
                        cursor: pointer;
                        z-index: 100;
                        opacity: 0.8;
                        transition: opacity 0.3s;
                    }
                    
                    .scroll-btn:hover {
                        opacity: 1;
                    }
                    
                    .scroll-left {
                        left: 0;
                    }
                    
                    .scroll-right {
                        right: 0;
                    }

                    .match-card {
                        flex: 0 0 auto;
                        width: 400px;
                        height: 220px;
                        border-radius: 8px;
                        background: #222; /* Lighter solid dark grey */
                        overflow: hidden;
                        cursor: pointer;
                        transition: transform 0.3s ease, box-shadow 0.3s ease;
                        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                        position: relative;
                        margin: 5px;
                    }

                    .match-card:hover {
                        transform: translateY(-5px);
                        box-shadow: 0 8px 16px rgba(0, 0, 0, 0.6);
                    }

                    .match-gradient-bg {
                        width: 100%;
                        height: 100%;
                        background: linear-gradient(135deg, #e50914 0%, #7b0810 100%);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 1.5rem;
                        position: relative;
                    }

                    .match-gradient-bg.upcoming {
                        background: linear-gradient(135deg, #2b5876 0%, #4e4376 100%);
                    }

                    .match-card:hover .match-gradient-bg {
                        background: linear-gradient(135deg, #ff0f1a 0%, #9b0813 100%);
                    }

                    .match-card:hover .match-gradient-bg.upcoming {
                        background: linear-gradient(135deg, #3a6f99 0%, #5f5493 100%);
                    }

                    .match-info {
                        text-align: center;
                        z-index: 2;
                        padding: 1rem;
                        width: 100%;
                    }

                    .match-title {
                        font-size: 1.3rem;
                        font-weight: 700;
                        margin-bottom: 1rem;
                        color: var(--light);
                        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
                    }

                    .teams-display {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 1rem;
                        margin: 1rem 0;
                    }

                    .team-name {
                        font-size: 1.1rem;
                        font-weight: 600;
                        color: white;
                        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
                    }

                    .vs-text {
                        font-size: 0.9rem;
                        color: rgba(255, 255, 255, 0.8);
                        font-weight: 500;
                    }

                    .match-time {
                        display: inline-block;
                        background: rgba(0, 0, 0, 0.3);
                        padding: 6px 12px;
                        border-radius: 4px;
                        font-size: 0.9rem;
                        color: var(--light);
                        margin-top: 1rem;
                        border: 1px solid rgba(255, 255, 255, 0.2);
                    }

                    .live-indicator {
                        position: absolute;
                        top: 10px;
                        right: 10px;
                        background: rgba(0, 0, 0, 0.5);
                        color: var(--light);
                        font-size: 0.7rem;
                        font-weight: 700;
                        padding: 5px 10px;
                        border-radius: 4px;
                        letter-spacing: 1px;
                        border: 1px solid rgba(255, 255, 255, 0.3);
                    }

                    .popular-indicator {
                        position: absolute;
                        top: 10px;
                        left: 10px;
                        background: var(--primary);
                        color: var(--light);
                        font-size: 0.7rem;
                        font-weight: 700;
                        padding: 5px 10px;
                        border-radius: 4px;
                        letter-spacing: 1px;
                        border: 1px solid rgba(255, 255, 255, 0.3);
                    }

                    .match-card:hover {
                        transform: translateY(-5px);
                        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.7);
                    }

                    .match-card:hover .match-gradient-bg {
                        background: linear-gradient(135deg, #ff0f1a 0%, #9b0813 100%);
                    }

                    .match-card:hover .match-gradient-bg.upcoming {
                        background: linear-gradient(135deg, #3a6f99 0%, #5f5493 100%);
                    }

                    .match-poster {
                        width: 100%;
                        height: 220px;
                        object-fit: contain;
                        background-color: #0a0a0a;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }

                    .match-time {
                        display: inline-block;
                        background: rgba(255, 255, 255, 0.1);
                        padding: 4px 8px;
                        border-radius: 4px;
                        font-size: 0.8rem;
                        color: var(--light);
                        margin-top: 0.5rem;
                    }

                    .no-matches {
                        background: rgba(0, 0, 0, 0.3);
                        padding: 2rem;
                        text-align: center;
                        border-radius: 8px;
                        margin-bottom: 2rem;
                        color: var(--gray);
                        font-size: 1.2rem;
                    }

                    @media (max-width: 768px) {
                        .navbar {
                            height: auto;
                            padding: 1rem 4%;
                            flex-direction: column;
                            gap: 1rem;
                        }

                        .search-container {
                            width: 100%;
                        }

                        .main-content {
                            padding-top: 140px;
                        }

                        .page-title {
                            font-size: 1.8rem;
                            flex-direction: column;
                            align-items: flex-start;
                            gap: 1rem;
                        }

                        .back-button {
                            margin-right: 0;
                            margin-bottom: 1rem;
                        }

                        .match-card {
                            width: 250px;
                        }
                    }
                </style>
               
                <script
                  type="text/javascript"
                  src="https://pl28055385.effectivegatecpm.com/c6/d8/57/c6d857d6d0087430d0c9bd203d8b610d.js"
                ></script>
            </head>
            <body>
                <nav class="navbar">
                    <a href="/" class="logo">allstream<span>cc.com</span></a>
                
                </nav>

                <main class="main-content">
                    <div class="page-title">
                        <button class="back-button" onclick="location.href='/'">
                            ← Back
                        </button>
                        ${sport.name} Matches
                    </div>
                    
                    ${popularMatchesHtml}
                    
                    ${liveMatchesHtml}
                    
                    ${upcomingMatchesHtml || `<div class="no-matches">No upcoming matches found for ${sport.name}.</div>`}
                </main>

                <div class="disclaimer-section">
                  <div class="disclaimer-content">
                    <p><strong>Contact:</strong> Please contact us through the Signal app @vookspook.26</p>
                    <p><strong>Disclaimer:</strong> We do not control any of the content posted. All content hosted is on 3rd party servers.</p>
                  </div>
                </div>
              

            </body>
            </html>
        `);
    } catch (error) {
        console.error('Error in /sports/:sportId endpoint:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Error - ALLSTREAMCC.COM</title>
                <meta name="description" content="Error on AllStreamCC.com. Visit AllStream.cc for live sports streaming.">
                <meta name="keywords" content="allstream.cc, allstreamcc.com, live sports, sports streaming">
                <meta property="og:site_name" content="AllStreamCC.com">
                <style>
                    body {
                        font-family: 'Montserrat', sans-serif;
                        background: #141414;
                        color: white;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        text-align: center;
                    }
                    .error-container {
                        max-width: 600px;
                        padding: 2rem;
                    }
                    h1 {
                        color: #e50914;
                        margin-bottom: 1rem;
                    }
                    p {
                        color: #999;
                        margin-bottom: 2rem;
                    }
                    a {
                        display: inline-block;
                        background: #e50914;
                        color: white;
                        padding: 10px 20px;
                        text-decoration: none;
                        border-radius: 4px;
                    }
                </style>

            <body>
                <div class="error-container">
                    <h1>Error Fetching Sports Data</h1>
                    <p>We encountered an error while fetching the sports data. This could be due to server issues or the data being temporarily unavailable.</p>
                    <a href="/">Go Back to Sports</a>
                </div>
               

            </body>
            </html>
        `);
    }
});

// Admin endpoint to manage banned users
app.get('/admin/banned-users', (req, res) => {
    const adminCode = req.query.code;
    
    // Verify admin code
    if (adminCode !== ADMIN_CODE) {
        return res.status(401).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Unauthorized - Admin Access</title>
                <style>
                    body {
                        font-family: 'Montserrat', sans-serif;
                        background: #141414;
                        color: white;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        text-align: center;
                    }
                    .error-container {
                        max-width: 600px;
                        padding: 2rem;
                        background: rgba(0, 0, 0, 0.4);
                        border-radius: 8px;
                    }
                    h1 {
                        color: #e50914;
                        margin-bottom: 1rem;
                    }
                    p {
                        color: #999;
                        margin-bottom: 2rem;
                    }
                    .form-container {
                        margin-top: 20px;
                    }
                    input {
                        padding: 10px;
                        border: none;
                        border-radius: 4px;
                        margin-right: 10px;
                    }
                    button {
                        background: #e50914;
                        color: white;
                        border: none;
                        padding: 10px 20px;
                        border-radius: 4px;
                        cursor: pointer;
                    }
                </style>
              
                <script
                  type="text/javascript"
                  src="https://pl28055385.effectivegatecpm.com/c6/d8/57/c6d857d6d0087430d0c9bd203d8b610d.js"
                ></script>

            </head>
            <body>
                <div class="error-container">
                    <h1>Admin Access Required</h1>
                    <p>Please enter the admin code to access this page</p>
                    
                    <form action="/admin/banned-users" method="get" class="form-container">
                        <input type="password" name="code" placeholder="Admin Code" required>
                        <button type="submit">Login</button>
                    </form>
                </div>
   

            </body>
            </html>
        `);
    }
    
    // Convert banned IPs to array for display
    const bannedList = [];
    for (const ip of bannedIPs) {
        const username = bannedIPsWithUsernames.get(ip) || 'Unknown';
        bannedList.push({ ip, username });
    }
    
    // Generate HTML for the admin panel
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Admin Panel - Banned Users</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body {
                font-family: 'Montserrat', sans-serif;
                background: #141414;
                color: white;
                margin: 0;
                padding: 20px;
            }
            
            .container {
                max-width: 1000px;
                margin: 0 auto;
                padding: 20px;
                background: rgba(0, 0, 0, 0.4);
                border-radius: 8px;
            }
            
            h1 {
                color: #e50914;
                margin-bottom: 20px;
                border-bottom: 1px solid #333;
                padding-bottom: 10px;
            }
            
            .banned-list {
                width: 100%;
                border-collapse: collapse;
                margin-top: 20px;
            }
            
            .banned-list th, .banned-list td {
                text-align: left;
                padding: 12px 15px;
                border-bottom: 1px solid #333;
            }
            
            .banned-list th {
                background-color: rgba(229, 9, 20, 0.2);
                color: #e50914;
                font-weight: 600;
            }
            
            .banned-list tr:hover {
                background-color: rgba(255, 255, 255, 0.05);
            }
            
            .banned-list tr:last-child td {
                border-bottom: none;
            }
            
            .unban-btn {
                background: #e50914;
                color: white;
                border: none;
                padding: 8px 12px;
                border-radius: 4px;
                cursor: pointer;
                transition: background 0.2s;
            }
            
            .unban-btn:hover {
                background: #f40612;
            }
            
            .empty-message {
                text-align: center;
                color: #999;
                padding: 20px;
                font-style: italic;
            }
            
            .back-btn {
                display: inline-block;
                background: rgba(255, 255, 255, 0.1);
                color: white;
                text-decoration: none;
                padding: 10px 15px;
                border-radius: 4px;
                margin-bottom: 20px;
            }
            
            .back-btn:hover {
                background: rgba(255, 255, 255, 0.2);
            }
            
            .success-message {
                background: rgba(40, 167, 69, 0.2);
                border-left: 4px solid #28a745;
                padding: 10px 15px;
                margin-bottom: 20px;
                border-radius: 4px;
            }
        </style>

        <script
          type="text/javascript"
          src="https://pl28055385.effectivegatecpm.com/c6/d8/57/c6d857d6d0087430d0c9bd203d8b610d.js"
        ></script>
    </head>
    <body>
        <div class="container">
            <a href="/" class="back-btn">← Back to Home</a>
            
            <h1>Banned Users Management</h1>
            
            ${req.query.success ? `<div class="success-message">${req.query.success}</div>` : ''}
            
            <form action="/admin/unban" method="post">
                <input type="hidden" name="code" value="${adminCode}">
                
                <table class="banned-list">
                    <thead>
                        <tr>
                            <th>IP Address</th>
                            <th>Username</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${bannedList.length > 0 ? bannedList.map(item => `
                            <tr>
                                <td>${item.ip}</td>
                                <td>${item.username}</td>
                                <td>
                                    <button type="submit" name="ip" value="${item.ip}" class="unban-btn">Unban</button>
                                </td>
                            </tr>
                        `).join('') : `
                            <tr>
                                <td colspan="3" class="empty-message">No banned users</td>
                            </tr>
                        `}
                    </tbody>
                </table>
            </form>
        </div>
       
    </body>
    </html>
    `;
    
    res.send(html);
});

// Endpoint to process unbanning
app.post('/admin/unban', express.urlencoded({ extended: true }), (req, res) => {
    const { code, ip } = req.body;
    
    // Verify admin code
    if (code !== ADMIN_CODE) {
        return res.status(401).send('Unauthorized');
    }
    
    // Check if IP exists in banned set
    if (!bannedIPs.has(ip)) {
        return res.redirect(`/admin/banned-users?code=${code}&success=IP ${ip} not found in banned list`);
    }
    
    // Remove IP from banned set
    bannedIPs.delete(ip);
    bannedIPsWithUsernames.delete(ip);
    
    // Redirect back to admin page with success message
    res.redirect(`/admin/banned-users?code=${code}&success=Successfully unbanned IP: ${ip}`);
});

// Start the server
const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});

// Add a /sports endpoint that redirects to the home page
app.get('/sports', (req, res) => {
    res.redirect('/');
});
