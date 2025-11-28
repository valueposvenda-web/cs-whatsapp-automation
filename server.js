const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const WASENDER_API_KEY = process.env.WASENDER_API_KEY;
const WASENDER_SECRET = process.env.WASENDER_WEBHOOK_SECRET;
const LINDY_WEBHOOK_URL = process.env.LINDY_WEBHOOK_URL;
const LINDY_SECRET = process.env.LINDY_SECRET_KEY;

// Armazena conversas (em produção, use banco de dados)
const conversations = new Map();

// Health check para UptimeRobot
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Webhook do WASender
app.post('/webhook', async (req, res) => {
  try {
    // Valida assinatura do webhook
    if (req.headers['x-webhook-signature'] !== WASENDER_SECRET) {
      console.log('❌ Assinatura inválida');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Responde imediatamente (WASender espera resposta rápida)
    res.status(200).json({ received: true });

    const { event, data } = req.body;

    // Processa apenas mensagens recebidas
    if (event === 'messages.upsert' && !data.key.fromMe) {
      const phone = data.key.remoteJid.replace('@s.whatsapp.net', '');
      const text = data.message.conversation || 
                   data.message.extendedTextMessage?.text || 
                   '[mídia não suportada]';
      const senderName = data.pushName || 'Cliente';

      console.log(`📱 Mensagem recebida de ${senderName} (${phone}): ${text}`);

      // Busca ou cria conversa
      const conv = conversations.get(phone) || {
        history: [],
        firstContact: Date.now(),
        customerType: 'new'
      };
      conv.history.push({ role: 'user', content: text });
      conv.lastActivity = Date.now();

      // Determina fase do cliente
      const daysSinceFirst = (Date.now() - conv.firstContact) / 86400000;
      const daysSinceLast = (Date.now() - conv.lastActivity) / 86400000;

      if (conv.customerType === 'new' && conv.history.length > 1) {
        conv.customerType = 'returning';
      }
      if (daysSinceLast > 14) {
        conv.customerType = 'at_risk';
      }
      if (daysSinceFirst > 30) {
        conv.customerType = 'established';
      }

      conversations.set(phone, conv);

      try {
        // Chama Lindy AI
        console.log(`🤖 Enviando para Lindy AI...`);
        const lindyResponse = await axios.post(LINDY_WEBHOOK_URL, {
          message: text,
          sender: phone,
          senderName: senderName,
          customerType: conv.customerType,
          conversationHistory: conv.history.slice(-5),
          context: `Cliente ${conv.customerType}. Dias desde primeiro contato: ${Math.floor(daysSinceFirst)}`
        }, {
          headers: {
            'Authorization': `Bearer ${LINDY_SECRET}`,
            'Content-Type': 'application/json'
          },
          timeout: 25000
        });

        const reply = lindyResponse.data.response || 
                      lindyResponse.data.message || 
                      'Recebemos sua mensagem. Obrigado!';

        console.log(`✅ Resposta Lindy: ${reply}`);

        // Salva resposta no histórico
        conv.history.push({ role: 'assistant', content: reply });

        // Envia resposta via WASender
        console.log(`📤 Enviando resposta para ${phone}...`);
        await axios.post('https://www.wasenderapi.com/api/send-message', {
          to: phone,
          text: reply
        }, {
          headers: {
            'Authorization': `Bearer ${WASENDER_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        });

        console.log(`✅ Mensagem enviada com sucesso!`);

      } catch (error) {
        console.error(`❌ Erro ao processar mensagem:`, error.message);
        
        // Tenta enviar mensagem de erro
        try {
          await axios.post('https://www.wasenderapi.com/api/send-message', {
            to: phone,
            text: '❌ Desculpe, ocorreu um erro ao processar sua mensagem. Tente novamente.'
          }, {
            headers: {
              'Authorization': `Bearer ${WASENDER_API_KEY}`
            }
          });
        } catch (e) {
          console.error('Erro ao enviar mensagem de erro:', e.message);
        }
      }
    }
  } catch (error) {
    console.error('❌ Erro geral no webhook:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`✅ Endpoint /health disponível`);
  console.log(`✅ Webhook pronto em POST /webhook`);
});
