# 🎸 Sonora Fan

Plataforma colaborativa onde usuários podem criar salas, adicionar músicas do YouTube e conversar em tempo real — como um show, mas com você no controle da playlist.

![Sonora Fan](https://img.shields.io/badge/version-1.0.0-blue)
![Node.js](https://img.shields.io/badge/Node.js-18.x-green)
![Socket.io](https://img.shields.io/badge/Socket.io-4.x-purple)
![License](https://img.shields.io/badge/license-MIT-orange)

## ✨ Funcionalidades

- 🎵 **Fila colaborativa** - Todo mundo adiciona música do YouTube, a fila toca em sincronia para todos os ouvintes
- 💬 **Chat ao vivo** - Comente as músicas, reaja com emojis e curta as escolhas dos DJs da sala
- 🎛️ **Painel Administrativo** - Gerencie usuários, salas e configurações do sistema
- 🎨 **Temas visuais** - Escolha entre Dark, Light, Neon e Terra Sonora
- 👑 **Sistema de Admin** - Promova usuários, limpe chats e gerencie salas
- 📱 **Design responsivo** - Funciona perfeitamente no desktop e mobile
- ⏱️ **Controle de duração** - Limite de 10 minutos por música
- 📊 **Chat limitado** - Mantém apenas as últimas 10 mensagens para melhor performance

## 🚀 Tecnologias

### Frontend
- **HTML5** - Estrutura da aplicação
- **CSS3** - Estilização com variáveis CSS para temas
- **JavaScript (Vanilla)** - Toda a lógica do frontend
- **YouTube IFrame Player API** - Reprodução de vídeos

### Backend
- **Node.js** - Runtime JavaScript
- **Express** - Framework web
- **Socket.io** - Comunicação em tempo real
- **Cookie-parser** - Gerenciamento de sessões

## 📦 Instalação

### Pré-requisitos

- Node.js (v14 ou superior)
- NPM ou Yarn
- Conexão com internet (para carregar APIs do YouTube)

### Passos

1. Clone o repositório:
```bash
git clone https://github.com/seu-usuario/sonora-fan.git
cd sonora-fan