const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Configurações
const WASENDER_API_KEY = process.env.WASENDER_API_KEY;
const LINDY_WEBHOOK_URL = process.env.LINDY_WEBHOOK_URL || 'https://public.lindy.ai/api/v1/webhooks/lindy/df7f842f-93b6-467d-bc49-f9fbebcfe063';
const WASENDER_BASE_URL = 'https://wasenderapi.com/api';

// Armazenar contexto de conversas
const conversationContext = new Map();

// ==================== ENDPOINTS ====================

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Main Webhook - Recebe mensagens do WASender
app.post('/webhook', async (req, res) => {
  try {
    console.log('📨 Webhook recebido:', JSON.stringify(req.body, null, 2));

    if (!req.body || !req.body.data) {
      console.log('⚠️ Body vazio ou sem data');
      return res.status(200).json({ received: true });
    }

    // PARSER CORRIGIDO para WASender
    const event = req.body.event;
    const messageData = req.body.data.messages;
    
    if (!messageData) {
      console.log('⚠️ Sem dados de mensagem');
      return res.status(200).json({ received: true });
    }

    // Extrair telefone do remoteJid
    let phone = messageData.remoteJid;
    if (!phone) {
      console.log('⚠️ Sem telefone');
      return res.status(200).json({ received: true });
    }

    // Se for grupo, usar participant
    if (phone.includes('@g.us') && messageData.key?.participant) {
      phone = messageData.key.participant;
    }

    // Extrair mensagem de texto
    let message = null;
    const msg = messageData.message;
    
    if (msg.conversation) {
      message = msg.conversation;
    } else if (msg.extendedTextMessage?.text) {
      message = msg.extendedTextMessage.text;
    } else if (msg.imageMessage?.caption) {
      message = `[Imagem] ${msg.imageMessage.caption}`;
    } else if (msg.audioMessage) {
      message = '[Áudio recebido]';
    } else if (msg.documentMessage) {
      message = `[Documento] ${msg.documentMessage.title || 'Documento'}`;
    } else {
      message = '[Mensagem sem texto]';
    }

    // Se for mensagem de system (como senderKeyDistributionMessage), ignorar
    if (msg.senderKeyDistributionMessage || !message) {
      console.log('⏭️ Ignorando mensagem de sistema');
      return res.status(200).json({ received: true });
    }

    console.log(`✅ Extraído: phone=${phone}, message="${message}"`);

    // Processar mensagem
    const resultado = await processarMensagem(phone, message);

    res.status(200).json({
      received: true,
      processed: true,
      response_sent: resultado.enviada,
      customer_type: resultado.customer_type
    });

  } catch (error) {
    console.error('❌ Erro no webhook:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== FUNÇÕES PRINCIPAIS ====================

async function processarMensagem(phone, mensagem) {
  try {
    console.log(`🔄 Processando: ${phone} - "${mensagem}"`);

    // Contexto
    let contexto = conversationContext.get(phone) || {
      phone,
      messages: [],
      customer_type: 'novo',
      created_at: new Date()
    };

    contexto.messages.push({
      role: 'user',
      content: mensagem,
      timestamp: new Date()
    });

    // Enviar para Lindy
    const lindyResponse = await enviarParaLindy(phone, mensagem, contexto);

    if (!lindyResponse) {
      console.error('❌ Lindy não respondeu');
      return { enviada: false, customer_type: contexto.customer_type };
    }

    // Extrair resposta
    const resposta = lindyResponse.response || 'Obrigado! Logo retornamos.';
    const customer_type = lindyResponse.customer_type || 'desconhecido';
    const requires_human = lindyResponse.requires_human || false;

    contexto.customer_type = customer_type;
    contexto.messages.push({
      role: 'assistant',
      content: resposta,
      timestamp: new Date()
    });

    conversationContext.set(phone, contexto);

    // Enviar resposta
    const enviada = await enviarRespostaWhatsApp(phone, resposta);

    console.log(`✅ Concluído: ${customer_type}, Escalação: ${requires_human}`);

    return { enviada, customer_type, requires_human };

  } catch (error) {
    console.error('❌ Erro ao processar:', error.message);
    return { enviada: false, customer_type: 'erro' };
  }
}

async function enviarParaLindy(phone, mensagem, contexto) {
  try {
    console.log(`📤 Enviando para Lindy...`);

    const payload = {
      message: mensagem,
      phone: phone,
      customer_type: contexto.customer_type,
      conversation_history: contexto.messages.slice(-5),
      timestamp: new Date().toISOString()
    };

    const response = await axios.post(LINDY_WEBHOOK_URL, payload, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CS-WhatsApp-Automation/1.0'
      }
    });

    console.log('📥 Lindy respondeu:', JSON.stringify(response.data, null, 2));
    return response.data;

  } catch (error) {
    console.error('❌ Erro Lindy:', error.message);
    return {
      response: 'Desculpe, estou com problemas técnicos.',
      customer_type: contexto.customer_type,
      requires_human: true
    };
  }
}

async function enviarRespostaWhatsApp(phone, mensagem) {
  try {
    console.log(`📱 Enviando resposta para ${phone}`);

    // Limpar número
    let phoneClean = phone.replace(/\D/g, '');
    
    // Se for ID do WhatsApp, pular
    if (phone.includes('@')) {
      console.log('⚠️ ID do WhatsApp, pulando envio');
      return false;
    }

    const response = await axios.post(
      `${WASENDER_BASE_URL}/send-message`,
      {
        phone: phoneClean,
        message: mensagem,
        isGroup: false
      },
      {
        headers: {
          'Authorization': `Bearer ${WASENDER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    console.log('✅ Enviado:', response.data);
    return true;

  } catch (error) {
    console.error('❌ Erro envio:', error.message);
    return false;
  }
}

// ==================== DEBUG ====================

app.get('/conversation/:phone', (req, res) => {
  const contexto = conversationContext.get(req.params.phone);
  res.json(contexto || { error: 'Não encontrada' });
});

app.delete('/conversation/:phone', (req, res) => {
  conversationContext.delete(req.params.phone);
  res.json({ deleted: true });
});

app.get('/conversations', (req, res) => {
  const conversas = Array.from(conversationContext.entries()).map(([phone, ctx]) => ({
    phone,
    customer_type: ctx.customer_type,
    messages_count: ctx.messages.length,
    created_at: ctx.created_at
  }));
  res.json({ total: conversas.length, conversas });
});

app.post('/test-webhook', async (req, res) => {
  const resultado = await processarMensagem('+5537999024357', 'Teste do sistema');
  res.json({ test: true, resultado });
});

// ==================== INICIAR ====================

app.listen(PORT, () => {
  console.log('🚀 Servidor rodando em http://localhost:' + PORT);
  console.log('✅ Webhook pronto em POST /webhook');
  console.log('✅ Health check em GET /health');
});

module.exports = app;
