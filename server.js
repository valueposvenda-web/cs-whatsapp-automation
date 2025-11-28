const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Configurações
const WASENDER_API_KEY = process.env.WASENDER_API_KEY;
const WASENDER_WEBHOOK_SECRET = process.env.WASENDER_WEBHOOK_SECRET;
const LINDY_WEBHOOK_URL = process.env.LINDY_WEBHOOK_URL || 'https://public.lindy.ai/api/v1/webhooks/lindy/df7f842f-93b6-467d-bc49-f9fbebcfe063';
const WASENDER_BASE_URL = 'https://wasenderapi.com/api';

// Armazenar contexto de conversas (em memória - recomendado usar DB em produção)
const conversationContext = new Map();

// ==================== ENDPOINTS ====================

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Main Webhook - Recebe mensagens do WASender
app.post('/webhook', async (req, res) => {
  try {
    console.log('📨 Webhook recebido do WASender:', JSON.stringify(req.body, null, 2));

    // Validar requisição
    if (!req.body) {
      return res.status(400).json({ error: 'Body vazio' });
    }

    // Extrair dados da mensagem
    const event = req.body.event || req.body.type;
    const phone = req.body.phone || req.body.sender;
    const message = req.body.message || req.body.body;

    // Se não for evento de mensagem recebida, ignora
    if (event !== 'messages.upsert' && event !== 'messages.received' && !message) {
      console.log('⏭️ Ignorando evento não-mensagem:', event);
      return res.status(200).json({ received: true });
    }

    if (!phone || !message) {
      console.log('⚠️ Dados incompletos:', { phone, message });
      return res.status(200).json({ received: true });
    }

    // Processar mensagem
    const resultado = await processarMensagem(phone, message);

    // Retornar sucesso
    res.status(200).json({
      received: true,
      processed: true,
      response_sent: resultado.enviada,
      customer_type: resultado.customer_type
    });

  } catch (error) {
    console.error('❌ Erro no webhook:', error.message);
    res.status(500).json({ 
      error: 'Erro ao processar', 
      message: error.message 
    });
  }
});

// ==================== FUNÇÕES PRINCIPAIS ====================

// 1. Processar mensagem do cliente
async function processarMensagem(phone, mensagem) {
  try {
    console.log(`🔄 Processando mensagem de ${phone}: "${mensagem}"`);

    // Obter ou criar contexto da conversa
    let contexto = conversationContext.get(phone) || {
      phone,
      messages: [],
      customer_type: 'novo',
      created_at: new Date()
    };

    // Adicionar mensagem ao histórico
    contexto.messages.push({
      role: 'user',
      content: mensagem,
      timestamp: new Date()
    });

    // 2. Enviar para Lindy AI processar
    const lindyResponse = await enviarParaLindy(phone, mensagem, contexto);

    if (!lindyResponse) {
      console.error('❌ Lindy não respondeu');
      return { enviada: false, customer_type: contexto.customer_type };
    }

    // 3. Extrair resposta do Lindy
    const resposta = lindyResponse.response || 'Obrigado pelo contato! Logo retornaremos.';
    const customer_type = lindyResponse.customer_type || 'desconhecido';
    const requires_human = lindyResponse.requires_human || false;

    // Atualizar contexto
    contexto.customer_type = customer_type;
    contexto.messages.push({
      role: 'assistant',
      content: resposta,
      timestamp: new Date()
    });

    // Salvar contexto
    conversationContext.set(phone, contexto);

    // 4. Enviar resposta de volta ao WhatsApp via WASender
    const enviada = await enviarRespostaWhatsApp(phone, resposta);

    console.log(`✅ Processo completo - Cliente: ${customer_type}, Escalação: ${requires_human}`);

    return {
      enviada,
      customer_type,
      requires_human
    };

  } catch (error) {
    console.error('❌ Erro ao processar mensagem:', error.message);
    return { enviada: false, customer_type: 'erro' };
  }
}

// 2. Enviar mensagem para Lindy AI
async function enviarParaLindy(phone, mensagem, contexto) {
  try {
    console.log(`📤 Enviando para Lindy: ${LINDY_WEBHOOK_URL}`);

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

    console.log('📥 Resposta do Lindy:', JSON.stringify(response.data, null, 2));

    return response.data || { response: 'Processado' };

  } catch (error) {
    console.error('❌ Erro ao conectar com Lindy:', error.message);
    return {
      response: 'Desculpe, estou tendo problemas técnicos. Em breve retornamos seu contato.',
      customer_type: contexto.customer_type,
      requires_human: true
    };
  }
}

// 3. Enviar resposta de volta ao WhatsApp
async function enviarRespostaWhatsApp(phone, mensagem) {
  try {
    console.log(`📱 Enviando resposta ao WhatsApp para ${phone}`);

    const phoneClean = phone.replace(/\D/g, '');

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

    console.log('✅ Mensagem enviada via WASender:', response.data);
    return true;

  } catch (error) {
    console.error('❌ Erro ao enviar via WASender:', error.message);
    
    try {
      await axios.post(
        `${WASENDER_BASE_URL}/send-message`,
        {
          number: phone,
          text: mensagem
        },
        {
          headers: {
            'Authorization': `Bearer ${WASENDER_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return true;
    } catch (fallbackError) {
      console.error('❌ Fallback também falhou:', fallbackError.message);
      return false;
    }
  }
}

// ==================== ENDPOINTS ADICIONAIS (DEBUG) ====================

// Ver contexto de uma conversa
app.get('/conversation/:phone', (req, res) => {
  const { phone } = req.params;
  const contexto = conversationContext.get(phone);

  if (!contexto) {
    return res.status(404).json({ error: 'Conversa não encontrada' });
  }

  res.json(contexto);
});

// Limpar contexto de uma conversa
app.delete('/conversation/:phone', (req, res) => {
  const { phone } = req.params;
  conversationContext.delete(phone);
  res.json({ deleted: true, phone });
});

// Ver todas as conversas (resumo)
app.get('/conversations', (req, res) => {
  const conversas = Array.from(conversationContext.entries()).map(([phone, ctx]) => ({
    phone,
    customer_type: ctx.customer_type,
    messages_count: ctx.messages.length,
    created_at: ctx.created_at,
    last_update: ctx.messages[ctx.messages.length - 1]?.timestamp
  }));

  res.json({
    total: conversas.length,
    conversas
  });
});

// Test endpoint - Simular mensagem de teste
app.post('/test-webhook', async (req, res) => {
  try {
    console.log('🧪 Testando webhook com mensagem simulada');

    const resultado = await processarMensagem(
      '+5537999024357',
      'Olá, gostaria de testar o sistema!'
    );

    res.json({
      test: true,
      resultado
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== INICIAR SERVIDOR ====================

app.listen(PORT, () => {
  console.log('🚀 Servidor rodando em http://localhost:' + PORT);
  console.log('✅ Endpoint /health disponível');
  console.log('✅ Webhook pronto em POST /webhook');
  console.log('✅ Lindy conectado em: ' + LINDY_WEBHOOK_URL);
  console.log('📊 Painel de debug:');
  console.log('   - GET /conversations (ver todas)');
  console.log('   - GET /conversation/:phone (ver específica)');
  console.log('   - DELETE /conversation/:phone (limpar)');
  console.log('   - POST /test-webhook (teste)');
});

module.exports = app;
