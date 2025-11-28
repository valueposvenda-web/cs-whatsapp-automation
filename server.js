const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const WASENDER_API_KEY = process.env.WASENDER_API_KEY;
const LINDY_WEBHOOK_URL = process.env.LINDY_WEBHOOK_URL;
const WASENDER_BASE_URL = 'https://wasenderapi.com/api';

// 🔒 MODO SEGURO - MUDE PARA FALSE QUANDO QUISER ATIVAR RESPOSTAS
const DRY_RUN_MODE = true; // TRUE = não envia nada, FALSE = envia para valer

const conversationContext = new Map();

// ==================== VALIDAÇÃO ====================
const isValidLindy = LINDY_WEBHOOK_URL && 
                     LINDY_WEBHOOK_URL.startsWith('https://public.lindy.ai/') &&
                     !LINDY_WEBHOOK_URL.includes('placeholder');

console.log('🔒 ==================== INICIALIZAÇÃO ====================');
console.log(`🔒 MODO SEGURO (DRY_RUN): ${DRY_RUN_MODE ? '✅ ATIVADO' : '❌ DESATIVADO'}`);
console.log(`✅ WASENDER API KEY: ${WASENDER_API_KEY ? 'Configurado' : '❌ Falta'}`);
console.log(`${isValidLindy ? '✅' : '❌'} LINDY URL: ${isValidLindy ? 'Válida' : 'Inválida'}`);
console.log('🔒 =====================================================');

if (DRY_RUN_MODE) {
  console.log('🚨 AVISO: DRY_RUN_MODE ativado!');
  console.log('🚨 Nenhuma mensagem será enviada para WhatsApp!');
  console.log('🚨 Tudo funcionará COMO SE fosse enviar, mas não enviará.');
}

// ==================== ENDPOINTS ====================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    dry_run_mode: DRY_RUN_MODE,
    lindy_configured: isValidLindy,
    timestamp: new Date().toISOString()
  });
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('📨 Webhook recebido:', JSON.stringify(req.body, null, 2));

    if (!req.body || !req.body.data) {
      return res.status(200).json({ received: true });
    }

    const event = req.body.event;
    const messageData = req.body.data.messages;
    
    if (!messageData) {
      return res.status(200).json({ received: true });
    }

    let phone = messageData.remoteJid;
    if (!phone) {
      return res.status(200).json({ received: true });
    }

    if (phone.includes('@g.us') && messageData.key?.participant) {
      phone = messageData.key.participant;
    }

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

    if (msg.senderKeyDistributionMessage || !message) {
      console.log('⏭️ Ignorando mensagem de sistema');
      return res.status(200).json({ received: true });
    }

    console.log(`✅ Extraído: phone=${phone}, message="${message}"`);

    const resultado = await processarMensagem(phone, message);

    res.status(200).json({
      received: true,
      processed: true,
      response_sent: resultado.enviada,
      customer_type: resultado.customer_type,
      dry_run_mode: DRY_RUN_MODE,
      message: DRY_RUN_MODE ? 'Simulado (não enviado)' : 'Enviado para valer'
    });

  } catch (error) {
    console.error('❌ Erro no webhook:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== FUNÇÕES ====================

async function processarMensagem(phone, mensagem) {
  try {
    console.log(`🔄 Processando: ${phone} - "${mensagem}"`);
    console.log(`   Modo: ${DRY_RUN_MODE ? '🟢 DRY_RUN (não envia)' : '🔴 PRODUÇÃO (envia de verdade)'}`);

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

    // Se estiver em DRY_RUN, não envia para Lindy
    if (DRY_RUN_MODE) {
      console.log('🟢 DRY_RUN: Simulando resposta (não enviando para Lindy)');
      
      const resposta = 'Olá! Obrigado pelo contato. [RESPOSTA SIMULADA]';
      const customer_type = 'novo';
      
      contexto.messages.push({
        role: 'assistant',
        content: resposta,
        timestamp: new Date()
      });

      conversationContext.set(phone, contexto);

      console.log(`✅ Simulado: ${customer_type}`);
      return { enviada: false, customer_type, requires_human: false };
    }

    // Se não tiver Lindy válida, não envia
    if (!isValidLindy) {
      console.log('❌ Lindy não configurado - não processando');
      return { enviada: false, customer_type: contexto.customer_type };
    }

    const lindyResponse = await enviarParaLindy(phone, mensagem, contexto);

    if (!lindyResponse) {
      console.error('❌ Lindy não respondeu');
      return { enviada: false, customer_type: contexto.customer_type };
    }

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

    const enviada = await enviarRespostaWhatsApp(phone, resposta);

    console.log(`✅ Concluído: ${customer_type}`);

    return { enviada, customer_type, requires_human };

  } catch (error) {
    console.error('❌ Erro:', error.message);
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

    // Se estiver em DRY_RUN, simula
    if (DRY_RUN_MODE) {
      console.log(`🟢 DRY_RUN: Não enviando para ${phone} (simulado)`);
      return false;
    }

    let phoneClean = phone.replace(/\D/g, '');
    
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

app.get('/status', (req, res) => {
  res.json({
    dry_run_mode: DRY_RUN_MODE,
    lindy_configured: isValidLindy,
    mode: DRY_RUN_MODE ? '🟢 SIMULAÇÃO (seguro)' : '🔴 PRODUÇÃO (envia de verdade)',
    message: DRY_RUN_MODE ? 'Nenhuma mensagem será enviada' : 'Mensagens serão enviadas para valer!'
  });
});

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

app.post('/test-webhook', (req, res) => {
  res.json({
    test: true,
    dry_run_mode: DRY_RUN_MODE,
    mode: DRY_RUN_MODE ? '🟢 Nada será enviado (seguro)' : '🔴 Será enviado de verdade',
    message: 'Teste executado'
  });
});

// ==================== INICIAR ====================

app.listen(PORT, () => {
  console.log('🚀 Servidor rodando em http://localhost:' + PORT);
  console.log(`🔒 Modo: ${DRY_RUN_MODE ? '🟢 DRY_RUN (SEGURO)' : '🔴 PRODUÇÃO'}`);
});

module.exports = app;
