const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const DatabaseManager = require('./database');
const FirexOTPService = require('./firexService');
const PaymentService = require('./paymentService');
const NotificationService = require('./notificationService');

class OTPBot {
  constructor() {
    this.bot = new TelegramBot(config.BOT_TOKEN, {
      polling: true,
      request: {
        timeout: 30000,
        agentOptions: {
          keepAlive: true,
          keepAliveMsecs: 10000
        }
      }
    });
    this.db = new DatabaseManager();
    this.firex = new FirexOTPService();
    this.payment = new PaymentService();
    this.notifier = new NotificationService();

    this.userStates = new Map();
    this.activeJobs = new Map();
    this.channelCheckInterval = null;

    this.setupHandlers();
    this.startChannelMonitoring();

    console.log('Fire OTP bot Started Successfully!');
  }

  setupHandlers() {
  this.bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => this.handleStart(msg, match));
  this.bot.onText(/\/balance/, (msg) => this.handleBalance(msg));
  this.bot.onText(/\/addmoney/, (msg) => this.handleAddMoney(msg));
  this.bot.onText(/\/giftredeem/, (msg) => this.handleGiftRedeem(msg));
  this.bot.onText(/\/search(.+)?/, (msg, match) => this.handleSearchCommand(msg, match[1]?.trim()));
  this.bot.onText(/\/discount/, (msg) => this.showDiscountInfo(msg.chat.id, msg.from.id));
  this.bot.onText(/\/admin/, (msg) => this.handleAdminCommand(msg));
  this.bot.onText(/\/profile/, (msg) => this.handleProfileCommand(msg));
  this.bot.onText(/\/referral/, (msg) => this.handleReferralCommand(msg));
  this.bot.onText(/\/broadcast/, (msg) => this.handleBroadcastCommand(msg));


  Object.keys(config.SERVICES).forEach(serviceId => {
    const command = config.SERVICES[serviceId].command.slice(1);
    this.bot.onText(new RegExp(`\\/${command}`), (msg) => this.handleServiceCommand(msg, serviceId));
  });

  this.bot.onText(/\/start quick_(.+)_(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const serviceId = match[1];
    const serverIndex = match[2];
    
    console.log(`🔄 Quick buy requested: ${serviceId}, Server: ${serverIndex}`);
    
    await this.handleServiceCommand(msg, serviceId);
  });

  this.bot.on('callback_query', (query) => this.handleCallbackQuery(query));
  this.bot.on('message', (msg) => this.handleMessage(msg));
}

  startChannelMonitoring() {
    this.channelCheckInterval = setInterval(async () => {
      try {
        const users = await this.db.getUsersForVerification();
        const batchSize = 10;
        for (let i = 0; i < users.length; i += batchSize) {
          const batch = users.slice(i, i + batchSize);
          await Promise.allSettled(batch.map(userId => this.checkAndNotifyUser(userId)));
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error('Channel monitoring error:', error);
      }
    }, 3 * 60 * 1000);
  }

  async checkAndNotifyUser(userId) {
    try {
      if (!await this.checkChannelMembership(userId)) {
        await this.db.setChannelLeft(userId);
        await this.notifyUserLeftChannel(userId);
      }
    } catch (error) {
      console.error(`Error checking user ${userId}:`, error.message);
    }
  }

  async notifyUserLeftChannel(userId) {
    try {
      await this.bot.sendMessage(userId, `❌ <b>Channel Join Required</b>\n\nYou have left our channel! To continue using the bot, please rejoin and verify.`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📢 Rejoin Channel', url: config.CHANNEL_LINK }],
            [{ text: '✅ Verify Again', callback_data: 'check_join' }]
          ]
        }
      });
    } catch (error) {
      console.error(`Failed to notify user ${userId}:`, error.message);
    }
  }

  async checkChannelMembership(userId) {
    try {
      const member = await this.bot.getChatMember(config.CHANNEL_ID, userId);
      await this.db.updateLastChecked(userId);
      return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error) {
      return false;
    }
  }

  setUserState(userId, state, data = {}) { this.userStates.set(userId, { state, data, timestamp: Date.now() }); }
  getUserState(userId) { return this.userStates.get(userId); }
  clearUserState(userId) { this.userStates.delete(userId); }
  setUserPagination(userId, page, data = {}) { this.userStates.set(userId, { state: 'browsing', page, data }); }

  getMainKeyboard() {
  return { 
    keyboard: [
      [{ text: '🛒 Buy OTP' }, { text: '💵 Deposit' }],
      [{ text: '🎟️ Redeem Gift' }, { text: '👤 Profile' }],
      [{ text: '👥 Refer & Earn' }, { text: '📊 My Orders' }],
      [{ text: '🏷️ Discount' }, { text: '🔴  Support' }]
    ], 
    resize_keyboard: true 
  };
}

  getCancelKeyboard() { return { keyboard: [[{ text: 'Back 🔄' }]], resize_keyboard: true }; }
  getAdminKeyboard() {
  return { 
    keyboard: [
      [{ text: '📚 Statistics' }, { text: '🛡️ User Management' }],
      [{ text: '💳 Balance Management' }, { text: '🎟️ Gift Codes' }],
      [{ text: '📈 Monthly Deposits' }, { text: '📢 Broadcast' }],
      [{ text: '⚙️ Settings' }, { text: 'Main Menu' }]
    ], 
    resize_keyboard: true 
  };
}

  async handleStart(msg, match) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const referralCode = match && match[1] ? match[1] : null;

    await this.db.updateUserProfile(userId, msg.from.first_name, msg.from.username);
    const user = await this.db.getUser(userId);
    await this.notifier.userRegistered(userId, msg.from.first_name, msg.from.username);
    const isMember = await this.checkChannelMembership(userId);

    if (referralCode && config.REFERRAL_SETTINGS.enabled) {
        try {
            const existingReferral = await this.db.getReferralByReferredId(userId);
            
            if (!existingReferral) {
                const referral = await this.db.getReferralByCode(referralCode);
                
                console.log(`🔍 Referral check - Code: ${referralCode}, Found: ${!!referral}, Referrer: ${referral?.referrer_id}, Current User: ${userId}`);

                if (referral && referral.referrer_id && referral.referrer_id !== userId) {
                    await this.db.createReferral(referral.referrer_id, userId, referralCode);
                    
                    console.log(`✅ Referral created - Referrer: ${referral.referrer_id}, Referred: ${userId}`);
                    
                    await this.bot.sendMessage(chatId, 
                        `🎉 <b>Referral Applied Successfully!</b>\n\n` +
                        `You joined using referral code: <code>${referralCode}</code>\n` +
                        `Welcome to the family! 🎊`,
                        { parse_mode: 'HTML' }
                    );

                    try {
                        await this.bot.sendMessage(referral.referrer_id,
                            `🎊 <b>New Referral Joined!</b>\n\n` +
                            `👤 New User: ${msg.from.first_name} (@${msg.from.username || 'N/A'})\n` +
                            `🆔 User ID: <code>${userId}</code>\n` +
                            `You'll earn 5% commission on their deposits! 💰`,
                            { parse_mode: 'HTML' }
                        );
                        console.log(`✅ Referrer notified: ${referral.referrer_id}`);
                    } catch (error) {
                        console.error('Referrer notification failed:', error);
                    }
                } else {
                    console.log(`❌ Self-referral blocked or invalid code - Referrer: ${referral?.referrer_id}, User: ${userId}`);
                    if (referral && referral.referrer_id === userId) {
                        await this.bot.sendMessage(chatId,
                            `❌ <b>Self-Referral Not Allowed</b>\n\n` +
                            `You cannot use your own referral code.`,
                            { parse_mode: 'HTML' }
                        );
                    }
                }
            } else {
                console.log(`ℹ️ User already has a referrer: ${existingReferral.referrer_id}`);
            }
        } catch (error) {
            console.error('Referral processing error:', error);
        }
    }

    if (!user.channel_joined || !isMember) {
      if (!isMember) await this.db.setChannelLeft(userId);
      return this.bot.sendMessage(chatId, `🔒 <b>Channel Join Required</b>\n\nTo use this bot, you must join our official channel first.\n\n⚠️ <b>Important:</b>\n• Join the channel above\n• Then click "I Have Joined ✅" below`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📢 Join Channel', url: config.CHANNEL_LINK }], [{ text: '✅ I Have Joined', callback_data: 'check_join' }]] } });
    }
    if (!user.terms_accepted) {
      return this.bot.sendMessage(chatId, `📝 <b>Terms & Conditions</b>\n\n<b>Dear Users, please read the Terms and Conditions carefully. We may be unable to provide support for issues resulting from not following these terms.</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Read full Terms and Conditions', url: 'https://telegra.ph/Fast-OTP--Terms--Conditions-09-22-2' }], [{ text: '✅ Accept Terms', callback_data: 'accept_terms' }], [{ text: '❌ Decline', callback_data: 'decline_terms' }]] } });
    }
    await this.showMainMenu(chatId, userId);
  }
  
  async verifyUserAccess(userId) {
    const user = await this.db.getUser(userId);
    if (!user.channel_joined) return { allowed: false, reason: 'channel' };
    const isMember = await this.checkChannelMembership(userId);
    if (!isMember) {
      await this.db.setChannelLeft(userId);
      return { allowed: false, reason: 'channel_left' };
    }
    if (!user.terms_accepted) return { allowed: false, reason: 'terms' };
    return { allowed: true };
  }

  async showMainMenu(chatId, userId) {
    const user = await this.db.getUser(userId);
    const monthlyDeposit = await this.db.getMonthlyDeposit(userId);
    const discountInfo = this.payment.getDiscountInfo(monthlyDeposit);
    let welcomeMessage = `<b>🔥 Fire OTP Bot</b>\n\n💳 <b>Balance:</b> ₹${this.payment.formatCurrency(user.balance)}`;
    if (discountInfo && discountInfo.currentDiscount > 0) welcomeMessage += `\n🎁 <b>Active Discount:</b> ${discountInfo.currentDiscount}%`;
    welcomeMessage += `\n\n🚀 <b>Fast & Reliable OTP Services</b>\n✅ 99% Success Rate\n⚡ Instant Delivery\n🛡️ Secure & Private\n\n🛒 <b>Select an option below:</b>`;
    await this.bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML', reply_markup: this.getMainKeyboard() });
  }

  async handleCallbackQuery(query) {
    const { message, from, data } = query;
    const chatId = message.chat.id;
    const userId = from.id;

    try {
      if (!data.startsWith('waiting_next_otp_')) await this.bot.answerCallbackQuery(query.id);

      if (!data.startsWith('check_join') && data !== 'accept_terms' && data !== 'decline_terms') {
        const access = await this.verifyUserAccess(userId);
        if (!access.allowed) {
          if (access.reason === 'channel_left') await this.notifyUserLeftChannel(userId);
          return;
        }
      }

      const handlers = {
        'check_join': () => this.handleJoinCheck(query),
        'accept_terms': () => this.handleTermsAccept(query),
        'decline_terms': () => this.handleTermsDecline(query),
        'add_money_start': () => this.showDepositMenu(chatId, userId),
        'search_service': () => this.handleSearchCommand(message),
        'main_menu': () => this.showMainMenu(chatId, userId),
        'discount_info': () => this.showDiscountInfo(chatId, userId),
        'cancel_locked': () => this.bot.answerCallbackQuery(query.id, { text: '⏳ Cancel option will unlock after 2 minutes.', show_alert: false }),
        'waiting_next_otp_': () => this.handleWaitingNextOTP(query),
        'profile_view': () => this.showUserProfile(chatId, userId),
        'profile_otp_history': () => this.showOTPHistory(chatId, userId),
        'profile_deposit_history': () => this.showDepositHistory(chatId, userId),
        'profile_transfer_balance': () => this.handleTransferBalanceStart(chatId, userId),
      };

      for (const prefix in handlers) {
        if (data.startsWith(prefix)) {
          return await handlers[prefix]();
        }
      }

      if (data.startsWith('buy_')) await this.handlePurchase(query);
      else if (data.startsWith('buy_new_')) await this.handleNewPurchase(query);
      else if (data.startsWith('check_')) await this.handleCheckSMS(query);
      else if (data.startsWith('cancel_')) await this.handleCancelOrder(query);
      else if (data.startsWith('new_number_')) await this.handleNewNumber(query);
      else if (data.startsWith('deposit_')) await this.handleDepositAmount(query);
      else if (data.startsWith('approve_') || data.startsWith('reject_')) await this.handleAdminApproval(query);
      else if (data.startsWith('all_services_')) await this.showAllServices(chatId, userId, parseInt(data.split('_')[2]));
      else if (data.startsWith('admin_')) await this.handleAdminCallback(query);
      else if (data.startsWith('transfer_')) await this.handleTransferCallback(query);
      else if (data.startsWith('broadcast_')) await this.handleBroadcastCallback(query);

      if (data === 'referral_list') {
      await this.showReferralList(chatId, userId);
      return;
    }
    
    if (data === 'referral_earnings') {
      await this.showReferralEarnings(chatId, userId);
      return;
    }
    
    if (data === 'referral_refresh') {
      await this.bot.deleteMessage(chatId, message.message_id);
      await this.showReferralDashboard(chatId, userId);
      return;
    }
    
    if (data === 'referral_back') {
      await this.bot.deleteMessage(chatId, message.message_id);
      await this.showReferralDashboard(chatId, userId);
      return;
    }
    } catch (error) {
      console.error('Callback query error:', error);
    }
  }

  async handleWaitingNextOTP(query) {
    await this.bot.answerCallbackQuery(query.id, { text: '⏳ Still waiting for your next SMS...', show_alert: true });
  }

  startWaitingCountdown(orderId, chatId, messageId, startTime) {
    const fifteenMinutes = 15 * 60 * 1000;
    
    const countdownInterval = setInterval(async () => {
      const job = this.activeJobs.get(orderId);
      if (!job) {
        return clearInterval(countdownInterval);
      }

      const timeElapsed = Date.now() - startTime;
      const timeLeft = Math.max(0, fifteenMinutes - timeElapsed);

      if (timeLeft <= 0) {
        return clearInterval(countdownInterval);
      }
      
      const minutes = Math.floor(timeLeft / 60000);
      const seconds = Math.floor((timeLeft % 60000) / 1000);
      const countdownText = `⏳ Waiting (${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')})`;

      const keyboard = {
        inline_keyboard: [
          [{ text: countdownText, callback_data: `waiting_next_otp_${orderId}` }],
          [{ text: 'Main Menu', callback_data: 'main_menu' }]
        ]
      };
      
      try {
        await this.bot.editMessageReplyMarkup(keyboard, { chat_id: chatId, message_id: messageId });
      } catch (e) {
        if (e.response && e.response.statusCode !== 400) {
           console.error("Countdown update error:", e.message);
        }
      }
    }, 2000);

    const job = this.activeJobs.get(orderId);
    if (job) {
      job.countdownInterval = countdownInterval;
      this.activeJobs.set(orderId, job);
    }
  }


  async startSMSChecking(orderId, activationId, userId, chatId, price, messageId, phoneNumber, serviceName, serviceCode, countryCode, serverName) {
  const orderStartTime = Date.now();
  const twoMinutes = 2 * 60 * 1000;
  const fifteenMinutes = 15 * 60 * 1000;

  const jobData = {
  interval: null, 
  startTime: orderStartTime, 
  messageId, 
  userId, 
  price, 
  chatId, 
  phoneNumber, 
  serviceName, 
  activationId,
  serviceCode, 
  countryCode, 
  serverName, 
  cancelUpdateInterval: null, 
  countdownInterval: null, 
  otpReceived: false, 
  lastOtp: null, 
  otpCount: 0,
  cancelling: false
};
  this.activeJobs.set(orderId, jobData);

  const getUpdatedKeyboard = (timeLeft = null, isOtpReceived = false) => {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔄 Check SMS', callback_data: `check_${orderId}` },
        ]
      ]
    };

    if (timeLeft !== null && timeLeft > 0 && !isOtpReceived) {
      const minutes = Math.floor(timeLeft / 60000);
      const seconds = Math.floor((timeLeft % 60000) / 1000);
      const countdownText = `🔒 Cancel (${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')})`;
      keyboard.inline_keyboard.push([{ text: countdownText, callback_data: 'cancel_locked' }]);
    } else if (timeLeft !== null && !isOtpReceived) {
      keyboard.inline_keyboard.push([{ text: '❌ Cancel Order', callback_data: `cancel_${orderId}` }]);
    }

   
    keyboard.inline_keyboard.push([
      { 
        text: `🔄 Buy ${serviceName} Again`, 
        callback_data: `buy_new_${serviceCode}_0` 
      }
    ]);

    keyboard.inline_keyboard.push([
      { text: '🛒 Browse Services', callback_data: 'all_services_0' },
    ]);

    return keyboard;
  };

  try {
    const initialKeyboard = getUpdatedKeyboard(twoMinutes);
    await this.bot.editMessageReplyMarkup(initialKeyboard, { 
      chat_id: chatId, 
      message_id: messageId 
    });
  } catch (error) {
 
  }

  const updateCancelButton = async () => {
    const job = this.activeJobs.get(orderId);
    if (!job || job.otpReceived) {
      if (job?.cancelUpdateInterval) clearInterval(job.cancelUpdateInterval);
      return;
    }
    
    try {
      const timeElapsed = Date.now() - job.startTime;
      const timeLeft = Math.max(0, twoMinutes - timeElapsed);
      
      const updatedKeyboard = getUpdatedKeyboard(timeLeft);
      
      await this.bot.editMessageReplyMarkup(updatedKeyboard, { 
        chat_id: chatId, 
        message_id: messageId 
      });

      if (timeLeft <= 0) {
        clearInterval(job.cancelUpdateInterval);
      }
    } catch (e) {
  
    }
  };

  jobData.cancelUpdateInterval = setInterval(updateCancelButton, 2000);
  this.activeJobs.set(orderId, jobData);

  const startOtpCountdown = async () => {
    const otpStartTime = Date.now();
    const otpCountdownInterval = setInterval(async () => {
      const job = this.activeJobs.get(orderId);
      if (!job) {
        clearInterval(otpCountdownInterval);
        return;
      }

      const timeElapsed = Date.now() - otpStartTime;
      const timeLeft = Math.max(0, fifteenMinutes - timeElapsed);

      if (timeLeft <= 0) {
        clearInterval(otpCountdownInterval);
        
        const sessionEndText = `⏰ <b>Session Expired</b>\n\n🆔 Order ID: ${orderId}\n✅ ${job.otpCount} OTPs Received\n⏳ 15-minute session completed.`;
        
        await this.bot.editMessageText(sessionEndText, { 
          chat_id: chatId, 
          message_id: messageId, 
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { 
                  text: `🔄 Buy ${serviceName} Again`, 
                  callback_data: `buy_new_${serviceCode}_0` 
                }
              ],
              [
                { text: '🛒 Browse Services', callback_data: 'all_services_0' },
              ]
            ]
          }
        }).catch(() => {});
        
        if (job.interval) clearInterval(job.interval);
        if (job.cancelUpdateInterval) clearInterval(job.cancelUpdateInterval);
        this.activeJobs.delete(orderId);
        return;
      }

      const minutes = Math.floor(timeLeft / 60000);
      const seconds = Math.floor((timeLeft % 60000) / 1000);
      const countdownText = `⏳ Waiting for more OTPs... (${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')})`;

      try {
        await this.bot.editMessageText(
          `🎉 <b>OTP Received!</b>\n\n` +
          `🔐 <b>OTP:</b> <code>${job.lastOtp}</code>\n` +
          `🛍️ <b>Service:</b> ${serviceName}\n` +
          `📱 <b>Number:</b> <code>${phoneNumber}</code>\n` +
          `${countdownText}\n\n` +
          `💡 <i>Still checking for more OTPs...</i>`,
          {
            chat_id: chatId, 
            message_id: messageId, 
            parse_mode: 'HTML',
            reply_markup: getUpdatedKeyboard(null, true)
          }
        );
      } catch (e) {
      }
    }, 2000);

    jobData.otpCountdownInterval = otpCountdownInterval;
    this.activeJobs.set(orderId, jobData);
  };


  const checkInterval = setInterval(async () => {
    const currentJob = this.activeJobs.get(orderId);
    if (!currentJob) return clearInterval(checkInterval);

    try {
      const orderData = await this.firex.checkOrder(activationId);

      if (orderData.status === 'SUCCESS' && orderData.code && orderData.code !== currentJob.lastOtp) {
        const code = orderData.code;
        currentJob.lastOtp = code;
        currentJob.otpCount += 1;

        if (!currentJob.otpReceived) {
          currentJob.otpReceived = true;
          await this.db.updateOrderOTP(orderId, code);
          await this.notifier.otpReceived({
            user_id: userId,
            service: serviceName,
            phone: phoneNumber,
            order_id: orderId
          }, code);
          
          if (currentJob.cancelUpdateInterval) clearInterval(currentJob.cancelUpdateInterval);

          await startOtpCountdown();

        } else {
          await this.bot.sendMessage(chatId, 
            `🆕 <b>Another OTP Received!</b>\n\n` +
            `🔐 <b>OTP Code:</b> <code>${code}</code>\n` +
            `📱 <b>Service:</b> ${serviceName}\n` +
            `📱 <b>Number:</b> <code>${phoneNumber}</code>\n` +
            `🆔 <b>Order ID:</b> ${orderId}\n` +
            `📊 <b>Total OTPs:</b> ${currentJob.otpCount}`,
            { parse_mode: 'HTML' }
          );
        }
        this.activeJobs.set(orderId, currentJob);
      } else if (orderData.status === 'CANCELLED') {
        if(currentJob.interval) clearInterval(currentJob.interval);
        if(currentJob.cancelUpdateInterval) clearInterval(currentJob.cancelUpdateInterval);
        if(currentJob.otpCountdownInterval) clearInterval(currentJob.otpCountdownInterval);
        this.activeJobs.delete(orderId);
        await this.db.removeActiveOrder(orderId);
        
        const cancelKeyboard = {
          inline_keyboard: [
            [
              { text: '🛒 Browse Services', callback_data: 'all_services_0' }
            ]
          ]
        };
        
        await this.bot.editMessageText(
          '❌ Order cancelled by system.', 
          { 
            chat_id: chatId, 
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: cancelKeyboard
          }
        );
      }
    } catch (error) { 
      console.error('SMS checking error:', error); 
    }
  }, 5000);

  jobData.interval = checkInterval;
  this.activeJobs.set(orderId, jobData);
  setTimeout(async () => {
    if (this.activeJobs.has(orderId)) {
      const job = this.activeJobs.get(orderId);
  
      if (job.interval) clearInterval(job.interval);
      if (job.cancelUpdateInterval) clearInterval(job.cancelUpdateInterval);
      if (job.otpCountdownInterval) clearInterval(job.otpCountdownInterval);
      if (job.countdownInterval) clearInterval(job.countdownInterval);
    
      this.activeJobs.delete(orderId);

      try {
        console.log(`🕒 Auto cancelling expired order: ${orderId}`);
        await this.firex.cancelOrder(job.activationId);
      } catch (cancelError) {
        console.error(`Auto cancel failed for ${orderId}:`, cancelError);
      }

      await this.db.removeActiveOrder(orderId);
      
      if (!job.otpReceived) {

        await this.db.cancelOrder(orderId);
        await this.db.updateBalance(job.userId, job.price);
        
        const refundMessage = `❌ <b>Order Expired & Auto Cancelled</b>\n\n🆔 Order ID: ${orderId}\n💰 Refunded: ₹${job.price}\n⏰ No OTP received within 15 minutes.`;
        
        await this.bot.editMessageText(refundMessage, { 
          chat_id: chatId, 
          message_id: job.messageId, 
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { 
                  text: `🔄 Buy ${serviceName} Again`, 
                  callback_data: `buy_new_${serviceCode}_0` 
                }
              ],
              [
                { text: '🛒 Browse Services', callback_data: 'all_services_0' },
              ]
            ]
          }
        }).catch(() => {});
        
      } else {
        const expiredMessage = `⏰ <b>Session Completed</b>\n\n🆔 Order ID: ${orderId}\n✅ ${job.otpCount} OTPs Received\n⏳ 15-minute session completed.`;
        
        await this.bot.editMessageText(expiredMessage, { 
          chat_id: chatId, 
          message_id: job.messageId, 
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { 
                  text: `🔄 Buy ${serviceName} Again`, 
                  callback_data: `buy_new_${serviceCode}_0` 
                }
              ],
              [
                { text: '🛒 Browse Services', callback_data: 'all_services_0' },
              ]
            ]
          }
        }).catch(() => {});
      }
    }
  }, fifteenMinutes);
}

async handleCheckSMS(query) {
  const chatId = query.message.chat.id;
  const orderId = query.data.split('_')[1];

  try {
    const job = this.activeJobs.get(orderId);
    if (!job) return await this.bot.answerCallbackQuery(query.id, { text: '❌ Order not found or already completed' });

    await this.bot.answerCallbackQuery(query.id, { text: '🔍 Checking for OTP...' });
    const orderData = await this.firex.checkOrder(job.activationId);

    if (orderData.status === 'SUCCESS' && orderData.code && orderData.code !== job.lastOtp) {
      const code = orderData.code;
      job.lastOtp = code;
      
      if (!job.otpReceived) {
          job.otpReceived = true;
          await this.db.updateOrderOTP(orderId, code);
          if (job.cancelUpdateInterval) clearInterval(job.cancelUpdateInterval);

          await this.bot.editMessageText(`🎉 <b>OTP Received!</b>\n🔐 <b>OTP Code:</b> <code>${code}</code>\n🛍️ <b>Service:</b> ${job.serviceName}\n📱 <b>Number:</b> <code>${job.phoneNumber}</code>\n\n💡 <i>Checking for more OTPs...</i>`, {
            chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML'
          });

          this.startWaitingCountdown(orderId, chatId, query.message.message_id, job.startTime);
      } else {
          await this.bot.sendMessage(chatId, `🆕 <b>Another OTP Received!</b>\n🔐 <b>OTP Code:</b> <code>${code}</code>`, { parse_mode: 'HTML' });
      }
      this.activeJobs.set(orderId, job);
    }
  } catch (error) { console.error('Check SMS error:', error); }
}


async handleProfileCommand(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const access = await this.verifyUserAccess(userId);
  if (!access.allowed) {
    await this.handleChannelBlock(chatId, access.reason);
    return;
  }

  await this.showUserProfile(chatId, userId);
}

async handleReferralCommand(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const access = await this.verifyUserAccess(userId);
  if (!access.allowed) {
    await this.handleChannelBlock(chatId, access.reason);
    return;
  }

  await this.showReferralDashboard(chatId, userId);
}

async showReferralDashboard(chatId, userId) {
  try {
    const referrals = await this.db.getUserReferrals(userId);
    
    const validReferrals = referrals.filter(ref => ref.referred_id !== userId);
    
    const referralEarnings = await this.db.getReferralEarnings(userId);
    const totalEarnings = await this.db.getTotalReferralEarnings(userId);
    
    const activeReferrals = validReferrals.filter(ref => {
      return referralEarnings.some(earning => earning.referred_id === ref.referred_id);
    });

    console.log(`📊 Referral Stats - Total: ${validReferrals.length}, Active: ${activeReferrals.length}, Earnings: ₹${totalEarnings}`);

    let referralCode;
    const existingCode = await this.db.getReferralCodeByUserId(userId);
    
    if (existingCode) {
      referralCode = existingCode;
      console.log(`✅ Using existing referral code: ${referralCode}`);
    } else {
      referralCode = this.payment.generateReferralCode();
      console.log(`✅ Generated new referral code: ${referralCode}`);

      try {
        await this.db.createReferral(userId, userId, referralCode);
        console.log(`✅ Referral code saved to database: ${referralCode}`);
      } catch (error) {
        console.error('❌ Error saving referral code:', error);
      }
    }

    const botUsername = (await this.bot.getMe()).username;
    const referralLink = `https://t.me/${botUsername}?start=${referralCode}`;
    
    const message = 
      `👥 <b>Referral Program</b>\n\n` +
      `🟢 <b>Your Stats:</b>\n` +
      `• Total Referrals: <b>${validReferrals.length}</b>\n` +
      `• Active Referrals: <b>${activeReferrals.length}</b>\n` +
      `• Total Earnings: <b>₹${totalEarnings}</b>\n\n` +
      `🔗 <b>Your Referral Link:</b>\n` +
      `<code>${referralLink}</code>\n\n` +
      `📋 <b>Your Referral Code:</b>\n` +
      `<code>${referralCode}</code>\n\n` +
      `💰 <b>Commission Rate:</b> 5% on every deposit\n\n` +
      `📢 <b>How it works:</b>\n` +
      `1. Share your link/code with friends\n` +
      `2. They join using your link\n` +
      `3. You earn 5% on their deposits\n` +
      `4. Commission added automatically!`;

    const keyboard = {
      inline_keyboard: [
        [{
          text: '📤 Share Link', 
          url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=Join%20this%20awesome%20OTP%20service!%20Get%20instant%20OTPs%20for%20all%20popular%20apps!`
        }],
        [
          { text: 'My Referrals', callback_data: 'referral_list' },
          { text: 'Earnings History', callback_data: 'referral_earnings' }
        ],
        [
          { text: 'Refresh', callback_data: 'referral_refresh' },
          { text: 'Main Menu', callback_data: 'main_menu' }
        ]
      ]
    };

    await this.bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });

  } catch (error) {
    console.error('Referral dashboard error:', error);
    await this.bot.sendMessage(chatId, 
      `❌ <b>Referral System Temporarily Unavailable</b>\n\nPlease try again later.`,
      { parse_mode: 'HTML' }
    );
  }
}

async showUserProfile(chatId, userId) {
  const user = await this.db.getUser(userId);
  const monthlyDeposit = await this.db.getMonthlyDeposit(userId);
  const currentDate = new Date().toLocaleDateString();
  const lastUpdated = new Date(user.last_checked).toLocaleString();

  const profileText = `
👤 <b>User Profile</b>

🆔 <b>User ID:</b> <code>${userId}</code>
👤 <b>Name:</b> ${user.first_name || 'Not set'}
📱 <b>Username:</b> ${user.username ? '@' + user.username : 'Not set'}
💳 <b>Balance:</b> ₹${this.payment.formatCurrency(user.balance)}
💰 <b>Monthly Deposit:</b> ₹${this.payment.formatCurrency(monthlyDeposit)}
📦 <b>Total Orders:</b> ${user.total_orders}
📅 <b>Joined Date:</b> ${new Date(user.joined_date).toLocaleDateString()}
🕒 <b>Last Active:</b> ${lastUpdated}
📆 <b>Current Date:</b> ${currentDate}
  `;

  const keyboard = {
    inline_keyboard: [
      [{ text: '📋 OTP History', callback_data: 'profile_otp_history' }],
      [{ text: '💰 Deposit History', callback_data: 'profile_deposit_history' }],
      [{ text: '🔄 Transfer Balance', callback_data: 'profile_transfer_balance' }],
      [{ text: 'Main Menu', callback_data: 'main_menu' }]
    ]
  };

  await this.bot.sendMessage(chatId, profileText, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

async showReferralList(chatId, userId) {
  try {
    const referrals = await this.db.getUserReferrals(userId);
    const referralEarnings = await this.db.getReferralEarnings(userId);

    let message = `📋 <b>Your Referrals</b>\n\n`;
    
    if (referrals.length === 0) {
      message += `You don't have any referrals yet.\n\n`;
      message += `Share your referral link to start earning! 💰`;
    } else {
      message += `Total Referrals: <b>${referrals.length}</b>\n\n`;
      
      referrals.forEach((ref, index) => {
        const hasDeposited = referralEarnings.some(earning => earning.referred_id === ref.referred_id);
        const userEarnings = referralEarnings.filter(earning => earning.referred_id === ref.referred_id);
        const totalEarned = userEarnings.reduce((sum, earning) => sum + earning.commission_amount, 0);
        
        message += `${index + 1}. <b>${ref.first_name || 'User'}</b> (@${ref.username || 'N/A'})\n`;
        message += `   🆔: <code>${ref.referred_id}</code>\n`;
        message += `   📅 Joined: ${new Date(ref.joined_at).toLocaleDateString()}\n`;
        message += `   💰 Earned: <b>₹${totalEarned}</b>\n`;
        message += `   📊 Status: ${hasDeposited ? '✅ Active' : '🟡 Inactive'}\n\n`;
      });
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔙 Back to Referral', callback_data: 'referral_back' }],
        [{ text: '🔄 Refresh', callback_data: 'referral_list' }]
      ]
    };

    await this.bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });

  } catch (error) {
    console.error('Referral list error:', error);
    await this.bot.sendMessage(chatId, '❌ Error loading referral list.');
  }
}

async showReferralEarnings(chatId, userId) {
  try {
    const earnings = await this.db.getReferralEarnings(userId);
    const totalEarnings = await this.db.getTotalReferralEarnings(userId);

    let message = `💰 <b>Referral Earnings History</b>\n\n`;
    message += `Total Earnings: <b>₹${totalEarnings}</b>\n\n`;
    
    if (earnings.length === 0) {
      message += `No earnings yet.\n`;
      message += `You'll earn 5% when your referrals deposit! 🎉`;
    } else {
      earnings.slice(0, 20).forEach((earning, index) => {
        message += `${index + 1}. <b>₹${earning.commission_amount}</b>\n`;
        message += `   👤 From: ${earning.first_name || 'User'} (ID: ${earning.referred_id})\n`;
        message += `   💳 Deposit: ₹${earning.deposit_amount}\n`;
        message += `   🎁 Commission: ${earning.commission_percent}%\n`;
        message += `   📅 Date: ${new Date(earning.earned_at).toLocaleString()}\n\n`;
      });
      
      if (earnings.length > 20) {
        message += `\n... and ${earnings.length - 20} more transactions`;
      }
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔙 Back to Referral', callback_data: 'referral_back' }],
        [{ text: '🔄 Refresh', callback_data: 'referral_earnings' }]
      ]
    };

    await this.bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });

  } catch (error) {
    console.error('Referral earnings error:', error);
    await this.bot.sendMessage(chatId, '❌ Error loading earnings history.');
  }
}

async showOTPHistory(chatId, userId) {
  const orders = await this.db.getUserOrders(userId);

  let historyText = '📋 <b>OTP History</b>\n\n';

  if (orders.length === 0) {
    historyText += 'No orders found.';
  } else {
    orders.forEach((order, index) => {
      const statusIcon = order.status === 'completed' ? '✅' : order.status === 'cancelled' ? '❌' : '🟡';
      historyText += `${statusIcon} <b>${order.service}</b>\n`;
      historyText += `📱 ${order.phone} | 💰 ₹${order.price}\n`;
      if (order.otp_code) {
        historyText += `🔐 OTP: <code>${order.otp_code}</code>\n`;
      }
      historyText += `🕒 ${new Date(order.order_time).toLocaleString()}\n\n`;
    });
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '🔙 Back to Profile', callback_data: 'profile_view' }],
      [{ text: 'Main Menu', callback_data: 'main_menu' }]
    ]
  };

  await this.bot.sendMessage(chatId, historyText, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

  async showOTPHistory(chatId, userId) {
    const orders = await this.db.getUserOrders(userId);

    let historyText = '📋 <b>OTP History</b>\n\n';

    if (orders.length === 0) {
      historyText += 'No orders found.';
    } else {
      orders.forEach((order, index) => {
        const statusIcon = order.status === 'completed' ? '✅' : order.status === 'cancelled' ? '❌' : '🟡';
        historyText += `${statusIcon} <b>${order.service}</b>\n`;
        historyText += `📱 ${order.phone} | 💰 ₹${order.price}\n`;
        if (order.otp_code) {
          historyText += `🔐 OTP: <code>${order.otp_code}</code>\n`;
        }
        historyText += `🕒 ${new Date(order.order_time).toLocaleString()}\n\n`;
      });
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔙 Back to Profile', callback_data: 'profile_view' }],
        [{ text: 'Main Menu', callback_data: 'main_menu' }]
      ]
    };

    await this.bot.sendMessage(chatId, historyText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async showDepositHistory(chatId, userId) {
    const deposits = await this.db.getUserDepositHistory(userId);

    let historyText = '💰 <b>Deposit History</b>\n\n';

    if (deposits.length === 0) {
      historyText += 'No deposit history found.';
    } else {
      deposits.forEach((deposit, index) => {
        const statusIcon = deposit.status === 'approved' ? '✅' : deposit.status === 'pending' ? '🟡' : '❌';
        historyText += `${statusIcon} <b>₹${deposit.amount}</b>\n`;
        historyText += `🆔 UTR: ${deposit.utr}\n`;
        historyText += `📊 Status: ${deposit.status}\n`;
        historyText += `🕒 ${new Date(deposit.request_time).toLocaleString()}\n\n`;
      });
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔙 Back to Profile', callback_data: 'profile_view' }],
        [{ text: 'Main Menu', callback_data: 'main_menu' }]
      ]
    };

    await this.bot.sendMessage(chatId, historyText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async handleTransferBalanceStart(chatId, userId) {
    this.setUserState(userId, 'awaiting_transfer_user');

    await this.bot.sendMessage(chatId, `
🔄 <b>Balance Transfer</b>

Please enter the User ID you want to transfer balance to:

Example: <code>123456789</code>

<b>Note:</b> You can only transfer to registered users.
    `.trim(), {
      parse_mode: 'HTML',
      reply_markup: this.getCancelKeyboard()
    });
  }

  async handleTransferUserInput(chatId, userId, targetUserId) {
    try {
      const targetUser = await this.db.getUser(parseInt(targetUserId));

      if (!targetUser) {
        await this.bot.sendMessage(chatId, '❌ User not found. Please check the User ID.');
        return;
      }

      if (parseInt(targetUserId) === userId) {
        await this.bot.sendMessage(chatId, '❌ You cannot transfer balance to yourself.');
        return;
      }

      this.setUserState(userId, 'awaiting_transfer_amount', { targetUserId: parseInt(targetUserId) });

      const currentUser = await this.db.getUser(userId);

      await this.bot.sendMessage(chatId, `
🔄 <b>Balance Transfer</b>

👤 <b>Transfer to:</b> User ID ${targetUserId}
💳 <b>Your Balance:</b> ₹${this.payment.formatCurrency(currentUser.balance)}

Please enter the amount to transfer:
      `.trim(), {
        parse_mode: 'HTML',
        reply_markup: this.getCancelKeyboard()
      });

    } catch (error) {
      console.error('Transfer user input error:', error);
      await this.bot.sendMessage(chatId, '❌ Error processing transfer. Please try again.');
    }
  }

    async handleTransferAmountInput(chatId, userId, amount) {
    try {
      const userState = this.getUserState(userId);
      const targetUserId = userState.data.targetUserId;

      const transferAmount = parseFloat(amount);

      if (isNaN(transferAmount) || transferAmount <= 0) {
        await this.bot.sendMessage(chatId, '❌ Please enter a valid amount.');
        return;
      }

      const currentUser = await this.db.getUser(userId);

      if (currentUser.balance < transferAmount) {
        await this.bot.sendMessage(chatId, `❌ Insufficient balance. You have ₹${this.payment.formatCurrency(currentUser.balance)}`);
        return;
      }

      this.setUserState(userId, 'awaiting_transfer_confirm', {
        targetUserId,
        amount: transferAmount
      });

      const targetUser = await this.db.getUser(targetUserId);

      await this.bot.sendMessage(chatId, `
🔄 <b>Confirm Balance Transfer</b>

👤 <b>From:</b> You (${userId})
👤 <b>To:</b> User ID ${targetUserId}
💰 <b>Amount:</b> ₹${transferAmount}

<b>Your balance after transfer:</b> ₹${this.payment.formatCurrency(currentUser.balance - transferAmount)}

Confirm this transfer?
      `.trim(), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Confirm', callback_data: `transfer_confirm` },
              { text: '❌ Cancel', callback_data: 'profile_view' }
            ]
          ]
        }
      });

    } catch (error) {
      console.error('Transfer amount input error:', error);
      await this.bot.sendMessage(chatId, '❌ Error processing transfer. Please try again.');
    }
  }

  async handleTransferCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  if (data === 'transfer_confirm') {
    const userState = this.getUserState(userId);
    
    if (!userState || !userState.data.targetUserId || !userState.data.amount) {
      await this.bot.editMessageText('❌ Transfer session expired. Please start again.', {
        chat_id: chatId,
        message_id: query.message.message_id
      });
      return;
    }

    const targetUserId = userState.data.targetUserId;
    const amount = userState.data.amount;

    try {
      await this.db.transferBalance(userId, targetUserId, amount, 'User transfer');
      await this.notifier.balanceTransferred(userId, targetUserId, amount, 'User transfer');
      
      const currentUser = await this.db.getUser(userId);
      const targetUser = await this.db.getUser(targetUserId);

      await this.bot.editMessageText(`
✅ <b>Transfer Successful!</b>

💰 <b>Amount:</b> ₹${amount}
👤 <b>To:</b> User ID ${targetUserId}
💳 <b>Your New Balance:</b> ₹${this.payment.formatCurrency(currentUser.balance)}

Transfer completed successfully.
      `.trim(), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });

      try {
        await this.bot.sendMessage(targetUserId, `
🎉 <b>Balance Received!</b>

💰 <b>Amount:</b> ₹${amount}
👤 <b>From:</b> User ID ${userId}
💳 <b>Your New Balance:</b> ₹${this.payment.formatCurrency(targetUser.balance)}

Balance transferred successfully.
        `.trim(), {
          parse_mode: 'HTML'
        });
      } catch (error) {
        console.error('Failed to notify receiver:', error);
      }

      this.clearUserState(userId);

    } catch (error) {
      console.error('Transfer error:', error);
      await this.bot.editMessageText('❌ Transfer failed. Please try again.', {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    }
  }
}

  async handleAdminCallback(query) {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (userId !== config.ADMIN_ID) {
      await this.bot.answerCallbackQuery(query.id, { text: '❌ Unauthorized' });
      return;
    }

    try {

      if (data === 'admin_stats') {
        await this.showAdminStats(chatId);
      }
      else if (data === 'admin_users') {
        await this.showUserManagement(chatId);
      }
      else if (data === 'admin_balance') {
        await this.showBalanceManagement(chatId);
      }
      else if (data === 'admin_gift') {
        await this.showGiftCodeManagement(chatId);
      }
      else if (data === 'admin_monthly') {
        await this.showMonthlyDepositManagement(chatId, query.message.message_id);
      }
      else if (data === 'admin_back') {
        await this.showAdminPanel(chatId, query.message.message_id);
      }
      else if (data === 'admin_deposit_start') {
        await this.handleManualDeposit(chatId);
      }
      else if (data === 'admin_deduct_start') {
        await this.handleBalanceDeduction(chatId);
      }
      else if (data === 'admin_monthly_reset_start') {
        await this.handleMonthlyDepositReset(chatId);
      }
      else if (data === 'admin_monthly_set_start') {
        await this.handleMonthlyDepositSet(chatId);
      }
      else if (data === 'admin_gift_create') {
        await this.handleGiftCodeCreation(chatId);
      }
      else if (data === 'admin_gift_list') {
        await this.showGiftCodeList(chatId);
      }
      else if (data === 'admin_user_search') {
        await this.handleUserSearch(chatId);
      }
      else if (data === 'admin_user_list') {
        await this.showAllUsers(chatId);
      }
      else if (data === 'admin_balance_reports') {
        await this.showBalanceReports(chatId);
      }
      else if (data.startsWith('admin_top_depositors_')) {
          const page = parseInt(data.split('_')[3]);
          await this.showTopDepositors(chatId, page, query.message.message_id);
      }
      else if (data.startsWith('admin_all_depositors_')) {
          const page = parseInt(data.split('_')[3]);
          await this.showAllDepositors(chatId, page, query.message.message_id);
      }
      else if (data.startsWith('admin_discounted_users_')) {
          const page = parseInt(data.split('_')[3]);
          await this.showDiscountedUsers(chatId, page, query.message.message_id);
      }
      else {
      }

    } catch (error) {
      console.error('Admin callback error:', error);
      await this.bot.sendMessage(chatId, '❌ Admin operation failed: ' + error.message);
    }
  }

  async handleBalanceDeduction(chatId) {
    this.setUserState(config.ADMIN_ID, 'admin_awaiting_deduct_user');

    await this.bot.sendMessage(chatId, `
➖ <b>Deduct Balance</b>

Please enter the User ID to deduct balance from:
    `.trim(), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Cancel', callback_data: 'admin_balance' }]
        ]
      }
    });
  }

  async handleMonthlyDepositReset(chatId) {
    this.setUserState(config.ADMIN_ID, 'admin_awaiting_reset_user');

    await this.bot.sendMessage(chatId, `
🔄 <b>Reset Monthly Deposit</b>

Please enter the User ID to reset this month's deposit to 0:
    `.trim(), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Cancel', callback_data: 'admin_monthly' }]
        ]
      }
    });
  }

  async handleMonthlyDepositSet(chatId) {
    this.setUserState(config.ADMIN_ID, 'admin_awaiting_set_user');

    await this.bot.sendMessage(chatId, `
📊 <b>Set Monthly Deposit</b>

Please enter the User ID to set a new monthly deposit value:
    `.trim(), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Cancel', callback_data: 'admin_monthly' }]
        ]
      }
    });
  }

  async handleGiftCodeCreation(chatId) {
    this.setUserState(config.ADMIN_ID, 'admin_awaiting_gift_amount');

    await this.bot.sendMessage(chatId, `
🎟️ <b>Create Gift Code</b>

Please enter the gift code amount:
    `.trim(), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Cancel', callback_data: 'admin_gift' }]
        ]
      }
    });
  }

  async showGiftCodeList(chatId) {
    const giftCodes = await this.db.getAllGiftCodes();

    let giftText = `
🎟️ <b>Gift Code List</b>

`;

    if (giftCodes.length === 0) {
      giftText += 'No gift codes found.';
    } else {
      giftCodes.forEach((code, index) => {
        const usedBy = code.used_by ? `Used by: ${code.used_by}` : 'Not used';
        giftText += `\n${index + 1}. <code>${code.code}</code> - ₹${code.amount}\n`;
        giftText += `   Status: ${usedBy} | Created: ${new Date(code.created_at).toLocaleDateString()}\n`;
      });
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: 'Back', callback_data: 'admin_gift' }]
      ]
    };

    await this.bot.sendMessage(chatId, giftText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async handleUserSearch(chatId) {
    this.setUserState(config.ADMIN_ID, 'admin_awaiting_search_user');

    await this.bot.sendMessage(chatId, `
🔍 <b>Search User</b>

Please enter User ID, name, or username to search:
    `.trim(), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Cancel', callback_data: 'admin_users' }]
        ]
      }
    });
  }

  async showAllUsers(chatId) {
    const users = await this.db.getAllUsers(50);

    let usersText = `
👥 <b>All Users</b> (Latest 50)

`;

    users.forEach((user, index) => {
      usersText += `\n${index + 1}. <b>${user.first_name || 'Unknown'}</b>\n`;
      usersText += `   🆔: <code>${user.user_id}</code> | 💰: ₹${user.balance} | 📦: ${user.total_orders}\n`;
      usersText += `   📅 Joined: ${new Date(user.joined_date).toLocaleDateString()}\n`;
    });

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔁 Back', callback_data: 'admin_users' }]
      ]
    };

    await this.bot.sendMessage(chatId, usersText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async showBalanceReports(chatId) {
    const totalUsers = await this.db.getTotalUsers();
    const totalRevenue = await this.db.getTotalRevenue();

    const reportText = `
🏦 <b>Balance Reports</b>

👥 Total Users: ${totalUsers}
💵 Total Revenue: ₹${this.payment.formatCurrency(totalRevenue)}

♻️ More detailed reports coming soon...
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔁 Back', callback_data: 'admin_balance' }]
      ]
    };

    await this.bot.sendMessage(chatId, reportText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async handleJoinCheck(query) {
    const chatId = query.message.chat.id;
    const userId = query.from.id;

    const isMember = await this.checkChannelMembership(userId);

    if (isMember) {
      await this.db.setChannelJoined(userId);

      try {
        await this.bot.deleteMessage(chatId, query.message.message_id);
      } catch (error) {
        console.log('Could not delete message:', error.message);
      }

      await this.bot.sendMessage(chatId, '✅ Channel verification successful! Please accept terms to continue.');

      const termsMessage = `
📝 <b>Terms & Conditions</b>

<b>Dear Users,

There are important Terms and Conditions provided below. Please read them carefully. If you face any issues or problems that are a result of not following these Terms, we may be unable to provide you with support or assistance.</b>
      `;

    const keyboard = {
    inline_keyboard: [
        [{
            text: 'Read full Terms and Conditions',
            url: 'https://telegra.ph/Fast-OTP--Terms--Conditions-09-22-2'
        }],
        [{ text: '✅ Accept Terms', callback_data: 'accept_terms' }],
        [{ text: '❌ Decline', callback_data: 'decline_terms' }]
    ]
}

      await this.bot.sendMessage(chatId, termsMessage, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } else {
      await this.bot.sendMessage(chatId, '❌ You haven\'t joined the channel yet!');

      await this.bot.answerCallbackQuery(query.id, {
        text: '❌ Please join the channel first',
        show_alert: false
      });
    }
  }

  async handleTermsAccept(query) {
    const chatId = query.message.chat.id;
    const userId = query.from.id;

    try {
        console.log('📊 Setting terms accepted for user:', userId);
        await this.db.setTermsAccepted(userId);
        console.log('✅ Terms set successfully in database');

        try {
            await this.bot.editMessageText('✅ Terms accepted! Welcome to Fire OTP Bot.', {
                chat_id: chatId,
                message_id: query.message.message_id
            });
            console.log('✅ Message edited successfully');
        } catch (editError) {
            console.log('⚠️ Edit failed, sending new message');
            await this.bot.sendMessage(chatId, '✅ Terms accepted! Welcome to Fire OTP Bot.');
        }

        this.clearUserState(userId);

        console.log('🎯 Showing main menu for user:', userId);
        await this.showMainMenu(chatId, userId);

    } catch (error) {
        console.error('❌ Terms accept error:', error);
        await this.bot.sendMessage(chatId, '❌ Error accepting terms. Please try /start again.');
    }
  }

  async handleTermsDecline(query) {
    const chatId = query.message.chat.id;
    await this.bot.editMessageText('❌ You must accept the terms to use this bot.', {
      chat_id: chatId,
      message_id: query.message.message_id
    });
  }

    async handleServiceCommand(msg, serviceId) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const access = await this.verifyUserAccess(userId);
    if (!access.allowed) {
      if (access.reason === 'channel_left') {
        await this.bot.sendMessage(chatId, '❌ You left the channel! Please rejoin to continue.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📢 Rejoin Channel', url: config.CHANNEL_LINK }]
            ]
          }
        });
      }
      await this.handleStart(msg);
      return;
    }

    await this.showServiceDetails(chatId, userId, serviceId);
  }

  async showServiceDetails(chatId, userId, serviceId) {
    const service = config.SERVICES[serviceId];
    const servers = config.SERVICE_SERVERS[serviceId] || config.SERVICE_SERVERS.DEFAULT;
    const user = await this.db.getUser(userId);
    const monthlyDeposit = await this.db.getMonthlyDeposit(userId);
    const discountInfo = this.payment.getDiscountInfo(monthlyDeposit);
    

    let serviceMessage = `
🛍️ <b>${service.name} Service</b>

📊 <b>Service Details:</b>
• Product: ${service.name}
• Country: India 🇮🇳
`;

    if (discountInfo && discountInfo.currentDiscount > 0) {
      serviceMessage += `• 🏷️ Discount: ${discountInfo.currentDiscount}% (Monthly)\n`;
    }

    serviceMessage += `
💰 <b>Your Balance:</b> ₹${this.payment.formatCurrency(user.balance)}`;

    if (discountInfo && discountInfo.nextTier) {
      serviceMessage += `\n🎯 <b>Next Tier:</b> Deposit ₹${discountInfo.nextTier.depositNeeded} more for ${discountInfo.nextTier.discount}% discount`;
    }

    serviceMessage += `\n\n⚡ <b>Available Servers:</b>`;

    const keyboard = {
      inline_keyboard: []
    };

    servers.forEach((server, index) => {
      const discountCalc = this.payment.calculateDiscountedPrice(server.price, monthlyDeposit);
      const finalPrice = this.payment.formatCurrency(discountCalc.finalPrice);

      let buttonText = `${server.name} - ₹${finalPrice}`;

      if (discountCalc.discount > 0) {
        buttonText += ` (${discountCalc.discountPercent}% OFF)`;
      } else {
        buttonText += ` (${server.success})`;
      }

      keyboard.inline_keyboard.push([
        {
          text: buttonText,
          callback_data: `buy_${serviceId}_${index}`
        }
      ]);
    });

    keyboard.inline_keyboard.push([
      { text: 'Back', callback_data: 'all_services_0' }
    ]);

    await this.bot.sendMessage(chatId, serviceMessage, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async showDiscountInfo(chatId, userId) {
    const monthlyDeposit = await this.db.getMonthlyDeposit(userId);
    const discountInfo = this.payment.getDiscountInfo(monthlyDeposit);

    let discountMessage = `
💷 <b>Your Monthly Deposit:</b> ₹${this.payment.formatCurrency(monthlyDeposit)}
🟢 <b>Current Discount:</b> ${discountInfo.currentDiscount}%

📜 <b>Discount Tiers:</b>
`;

    discountInfo.tiers.forEach(tier => {
      const status = monthlyDeposit >= tier.deposit ? '✅ ACHIEVED' : '🔒 LOCKED';
      const progress = monthlyDeposit >= tier.deposit ? '100%' :
        Math.min(100, Math.round((monthlyDeposit / tier.deposit) * 100)) + '%';

      discountMessage += `\n• ₹${tier.deposit}+ ${tier.discount}% discount ${status} (${progress})`;
    });

    if (discountInfo.nextTier) {
      discountMessage += `\n\n🎯 <b>Next Target:</b>\nTop-up ₹${discountInfo.nextTier.depositNeeded}+ to unlock ${discountInfo.nextTier.discount}% Off on all services!`;
    } else {
      discountMessage += `\n\n🎉 <b>Congratulations!</b>\nYou've unlocked the maximum discount tier!`;
    }

    discountMessage += `\n\n💡 <b>Note:</b> Monthly deposits reset on 1st of every month.`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '💵 Deposit Now', callback_data: 'add_money_start' }],
        [{ text: '🔙 Back', callback_data: 'main_menu' }]
      ]
    };

    await this.bot.sendMessage(chatId, discountMessage, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async handleSearchCommand(msg, searchTerm = '') {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const access = await this.verifyUserAccess(userId);
    if (!access.allowed) {
      await this.handleChannelBlock(chatId, access.reason);
      return;
    }

    if (!searchTerm) {
      this.setUserState(userId, 'awaiting_search');
      await this.bot.sendMessage(chatId, `
🔍 <b>Search Services</b>

Please enter the service name you want to search for:

Example: <code>shein</code>, <code>amazon</code>, <code>facebook</code>
      `.trim(), {
        parse_mode: 'HTML',
        reply_markup: this.getCancelKeyboard()
      });
      return;
    }

    await this.showSearchResults(chatId, userId, searchTerm);
  }

  async showSearchResults(chatId, userId, searchTerm) {
    const user = await this.db.getUser(userId);

    const searchResults = Object.entries(config.SERVICES)
      .filter(([serviceId, service]) =>
        service.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        serviceId.toLowerCase().includes(searchTerm.toLowerCase())
      )
      .slice(0, 30);

    if (searchResults.length === 0) {
      await this.bot.sendMessage(chatId, `
❌ <b>No Services Found</b>

No services found for: <code>${searchTerm}</code>

Please try a different search term.
      `.trim(), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to All Services', callback_data: 'all_services_0' }]
          ]
        }
      });
      return;
    }

    let searchText = `🔍 <b>Search Results for "${searchTerm}"</b>\n\n`;
    searchText += `<b>Please select service below 👇</b>\n\n`;

    searchResults.forEach(([serviceId, service], index) => {
      searchText += `${index + 1}. ${service.name} ➤ ${service.command}\n`;
    });

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔙 Back to All Services', callback_data: 'all_services_0' }]
      ]
    };

    await this.bot.sendMessage(chatId, searchText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async showAllServices(chatId, userId, page = 0) {
    const access = await this.verifyUserAccess(userId);
    if (!access.allowed) {
      await this.handleChannelBlock(chatId, access.reason);
      return;
    }

    const user = await this.db.getUser(userId);
    const servicesPerPage = 30;
    const allServices = Object.entries(config.SERVICES);
    const totalPages = Math.ceil(allServices.length / servicesPerPage);

    const startIndex = page * servicesPerPage;
    const endIndex = startIndex + servicesPerPage;
    const pageServices = allServices.slice(startIndex, endIndex);

    let servicesText = `📋 <b>All Available Services</b> (Page ${page + 1}/${totalPages})\n\n`;

    pageServices.forEach(([serviceId, service], index) => {
      const globalIndex = startIndex + index + 1;
      servicesText += `${globalIndex}. ${service.name} ➤ ${service.command}\n`;
    });

    const keyboard = {
      inline_keyboard: []
    };

    if (totalPages > 1) {
      const paginationRow = [];
      if (page > 0) {
        paginationRow.push({
          text: '⬅️ Previous',
          callback_data: `all_services_${page - 1}`
        });
      }
      if (page < totalPages - 1) {
        paginationRow.push({
          text: 'Next ➡️',
          callback_data: `all_services_${page + 1}`
        });
      }

      if (paginationRow.length > 0) {
        keyboard.inline_keyboard.push(paginationRow);
      }
    }

    keyboard.inline_keyboard.push([
      { text: 'Main Menu', callback_data: 'main_menu' }
    ]);

    this.setUserPagination(userId, page);

    await this.bot.sendMessage(chatId, servicesText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async handlePurchase(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  const access = await this.verifyUserAccess(userId);
  if (!access.allowed) {
    await this.handleChannelBlock(chatId, access.reason);
    return;
  }

  await this.bot.answerCallbackQuery(query.id);

  let serviceId, serverIndex;
  
  if (query.data.startsWith('buy_new_')) {
    [, , serviceId, serverIndex] = query.data.split('_');
  } else {
    [, serviceId, serverIndex] = query.data.split('_');
  }

  const service = config.SERVICES[serviceId];
  const servers = config.SERVICE_SERVERS[serviceId] || config.SERVICE_SERVERS.DEFAULT;
  const server = servers[parseInt(serverIndex)];

  if (!service || !server) {
    await this.bot.sendMessage(chatId, 'Service is not active...');
    return;
  }

  const user = await this.db.getUser(userId);
  const monthlyDeposit = await this.db.getMonthlyDeposit(userId);

  const discountCalc = this.payment.calculateDiscountedPrice(server.price, monthlyDeposit);
  const finalPrice = discountCalc.finalPrice;

  if (user.balance < finalPrice) {
    await this.bot.sendMessage(chatId,
      `❌ <b>Insufficient Balance</b>\n\n💰 Required: ₹${finalPrice}\n💳 Your Balance: ₹${this.payment.formatCurrency(user.balance)}\n\nPlease deposit money to continue.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const processingMsg = await this.bot.sendMessage(chatId,
    `🔄 <b>Processing Order...</b>\n\n📱 Service: ${service.name}\n💰 Price: ₹${finalPrice}${discountCalc.discount > 0 ? ` (${discountCalc.discountPercent}% OFF)` : ''}`,
    { 
      parse_mode: 'HTML'
    }
  );

  try {
    await this.db.updateBalance(userId, -finalPrice);

    const result = await this.firex.buyNumber(server.service, server.country);

    if (!result.success) {
      await this.db.updateBalance(userId, finalPrice);
      await this.bot.editMessageText(
        `${result.error}\n\n💰 Refunded: ₹${finalPrice}`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    const uniqueOrderId = `ORD${Date.now()}${Math.random().toString(36).substr(2, 5)}`.toUpperCase();

    let formattedPhone = result.number;
    if (formattedPhone.startsWith('+91')) {
      formattedPhone = formattedPhone.substring(3);
    } else if (formattedPhone.startsWith('91') && formattedPhone.length === 12) {
      formattedPhone = formattedPhone.substring(2);
    }

    await this.db.addOrder({
      user_id: userId,
      service: service.name,
      phone: formattedPhone,
      price: finalPrice,
      order_id: uniqueOrderId,
      activation_id: result.orderId,
      status: 'active',
      server_used: server.name,
      original_price: server.price,
      discount_applied: discountCalc.discount
    });

    await this.db.addActiveOrder({
      order_id: uniqueOrderId,
      activation_id: result.orderId,
      user_id: userId,
      phone: formattedPhone,
      product: service.name,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      server_used: server.name
    });

    const successText = `
✅ <b>Number Purchased!</b>

📱 <b>Number:</b> <code>${formattedPhone}</code>
🛍️ <b>Service:</b> ${service.name}
💰 <b>Price:</b> ₹${finalPrice}${discountCalc.discount > 0 ? ` (Saved: ₹${discountCalc.discount})` : ''}

⏰ <b>Time Limit:</b> 15 minutes
📩 <b>Waiting for SMS...</b>`;

    await this.notifier.orderPlaced({
      user_id: userId,
      service: service.name,
      phone: formattedPhone,
      price: finalPrice,
      order_id: uniqueOrderId,
      original_price: server.price,
      discount_applied: discountCalc.discount
    });

    const sentMessage = await this.bot.sendMessage(chatId, successText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔄 Check SMS', callback_data: `check_${uniqueOrderId}` },
          ],
          [
            { text: '🔒 Cancel (02:00)', callback_data: 'cancel_locked' }
          ],
          [
            { 
              text: `🔄 Buy ${service.name} Again`, 
              callback_data: `buy_new_${serviceId}_${serverIndex}` 
            }
          ],
        ]
      }
    });

    this.startSMSChecking(uniqueOrderId, result.orderId, userId, chatId, finalPrice, sentMessage.message_id, formattedPhone, service.name, serviceId, server.country, server.name);

  } catch (error) {
    console.error('Purchase error:', error);
    await this.db.updateBalance(userId, finalPrice);
    
    await this.bot.sendMessage(chatId,
      `❌ ${error.message || 'Purchase failed. Refund issued.'}\n\n💰 Refunded: ₹${finalPrice}`,
      { parse_mode: 'HTML' }
    );
  }
}

async handleCancelOrder(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const orderId = query.data.split('_')[1];

  try {
    const job = this.activeJobs.get(orderId);
    if (!job) {
      await this.bot.answerCallbackQuery(query.id, {
        text: '❌ Order not found or already completed'
      });
      return;
    }


    if (job.cancelling) {
      await this.bot.answerCallbackQuery(query.id, {
        text: '⏳ Cancellation already in progress...',
        show_alert: false
      });
      return;
    }

    const timeElapsed = Date.now() - job.startTime;
    const twoMinutes = 2 * 60 * 1000;

    if (timeElapsed < twoMinutes) {
      await this.bot.answerCallbackQuery(query.id, {
        text: '❌ Cancel option unlocks after 2 minutes',
        show_alert: true
      });
      return;
    }

    if (job.otpReceived) {
      await this.bot.answerCallbackQuery(query.id, {
        text: '❌ Cannot cancel - OTP already received',
        show_alert: true
      });
      return;
    }


    job.cancelling = true;
    this.activeJobs.set(orderId, job);

    await this.bot.editMessageText(`🔄 <b>Cancelling Order...</b>\n\nPlease wait...`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'HTML'
    });

    let cancelSuccess = await this.firex.cancelOrder(job.activationId);

    if (job.interval) clearInterval(job.interval);
    if (job.cancelUpdateInterval) clearInterval(job.cancelUpdateInterval);
    if (job.countdownInterval) clearInterval(job.countdownInterval);
    
    this.activeJobs.delete(orderId);

  
    await this.db.updateBalance(userId, job.price);
    await this.db.removeActiveOrder(orderId);
    await this.db.cancelOrder(orderId);

    await this.notifier.orderCancelled({
      user_id: userId,
      service: job.serviceName,
      phone: job.phoneNumber,
      price: job.price,
      order_id: orderId
    }, cancelSuccess ? 'User cancelled' : 'User cancelled (API failed)');

    const cancelSuccessText = `
✅ <b>Order Cancelled & Refunded</b>
📱 <b>Number:</b> <code>${job.phoneNumber}</code>
💰 <b>Refunded:</b> ₹${job.price}`;

    await this.bot.editMessageText(cancelSuccessText, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: `🔄 Buy ${job.serviceName} Again`, 
              callback_data: `buy_new_${job.serviceCode}_0` 
            }
          ],
          [
            { text: '🛒 Browse Services', callback_data: 'all_services_0' },
          ]
        ]
      }
    });

  } catch (error) {
    console.error('Cancel order error:', error);
    

    const job = this.activeJobs.get(orderId);
    if (job) {
      if (job.interval) clearInterval(job.interval);
      if (job.cancelUpdateInterval) clearInterval(job.cancelUpdateInterval);
      if (job.countdownInterval) clearInterval(job.countdownInterval);
      this.activeJobs.delete(orderId);
 
      try {
        await this.db.updateBalance(userId, job.price);
        await this.db.removeActiveOrder(orderId);
        await this.db.cancelOrder(orderId);
      } catch (refundError) {
        console.error('Refund during error also failed:', refundError);
      }
    }

    await this.bot.editMessageText(
      `❌ <b>Cancellation Error</b>\n\nTechnical error occurred but amount refunded.\nPlease contact support if issue persists.`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }
    );
  }
}


cleanupJob(orderId) {
  const job = this.activeJobs.get(orderId);
  if (job) {
    if (job.interval) clearInterval(job.interval);
    if (job.cancelUpdateInterval) clearInterval(job.cancelUpdateInterval);
    if (job.otpCountdownInterval) clearInterval(job.otpCountdownInterval);
    if (job.countdownInterval) clearInterval(job.countdownInterval);
    this.activeJobs.delete(orderId);
  }
}

  async handleNewNumber(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const orderId = query.data.split('_')[2];

  try {
    const job = this.activeJobs.get(orderId);
    if (!job) {
      await this.bot.answerCallbackQuery(query.id, {
        text: '❌ Order not found or already completed'
      });
      return;
    }

    await this.bot.answerCallbackQuery(query.id, {
      text: '🔄 Requesting new number...'
    });

    console.log(`🔄 Requesting new number for order: ${orderId}, Activation: ${job.activationId}`);
    const newNumberResult = await this.firex.requestNewNumber(job.activationId);
    
    if (newNumberResult.success) {
      if (this.activeJobs.has(orderId)) {
        const jobData = this.activeJobs.get(orderId);
        if (jobData.interval) clearInterval(jobData.interval);
        if (jobData.cancelUpdateInterval) clearInterval(jobData.cancelUpdateInterval);
        this.activeJobs.delete(orderId);
      }

      const service = config.SERVICES[job.serviceCode];
      const servers = config.SERVICE_SERVERS[job.serviceCode] || config.SERVICE_SERVERS.DEFAULT;
      const server = servers[job.serverIndex];

      if (!service || !server) {
        throw new Error('Service not available');
      }

      const result = await this.firex.buyNumber(server.service, server.country);

      if (!result.success) {
        await this.bot.sendMessage(chatId, 
          `❌ Failed to get new number: ${result.error}\n\nYour original order is still active.`
        );
        return;
      }

      let formattedPhone = result.number;
      if (formattedPhone.startsWith('+91')) {
        formattedPhone = formattedPhone.substring(3);
      } else if (formattedPhone.startsWith('91') && formattedPhone.length === 12) {
        formattedPhone = formattedPhone.substring(2);
      }

      job.phoneNumber = formattedPhone;
      job.activationId = result.orderId;
      job.startTime = Date.now();
      job.otpReceived = false;
      job.lastOtp = null;

      await this.db.updateOrderNumber(orderId, formattedPhone);
      await this.db.updateOrderActivationId(orderId, result.orderId);

      const successText = `
🔄 <b>New Number Assigned!</b>

📱 <b>New Number:</b> <code>${formattedPhone}</code>
🛍️ <b>Service:</b> ${job.serviceName}
💰 <b>Price:</b> ₹${job.price}
🆔 <b>Order ID:</b> ${orderId}

⏰ <b>Time Limit:</b> 15 minutes
📩 <b>Waiting for SMS...</b>`;

const initialKeyboard = {
  inline_keyboard: [
    [
      { text: '🔄 Check SMS', callback_data: `check_${uniqueOrderId}` },
    ],
    [
      { text: '🔒 Cancel (02:00)', callback_data: 'cancel_locked' }
    ],
    [
      { 
        text: `🔄 Buy ${service.name} Again`, 
        url: `https://t.me/${(await this.bot.getMe()).username}?start=quick_${serviceId}_${serverIndex}`
      }
    ],
    [
      { text: 'Main Menu', callback_data: 'main_menu' }
    ]
  ]
};

      await this.bot.editMessageText(successText, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: initialKeyboard
      });

      this.startSMSChecking(orderId, result.orderId, userId, chatId, job.price, 
        query.message.message_id, formattedPhone, job.serviceName, job.serviceCode, 
        job.countryCode, job.serverName);

      await this.notifier.newNumberRequested({
        user_id: userId,
        service: job.serviceName,
        order_id: orderId
      }, formattedPhone);

    } else {
      await this.bot.answerCallbackQuery(query.id, {
        text: `❌ ${newNumberResult.error || 'Failed to get new number'}`,
        show_alert: true
      });
    }
  } catch (error) {
    console.error('New number error:', error);
    await this.bot.answerCallbackQuery(query.id, {
      text: '❌ Error requesting new number: ' + error.message
    });
  }
}

  async handleAdminCommand(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (userId !== config.ADMIN_ID) {
      await this.bot.sendMessage(chatId, '❌ Unauthorized access.');
      return;
    }

    await this.showAdminPanel(chatId);
  }

  async showAdminPanel(chatId, messageId = null) {
    const adminText = `
🛠️ <b>Admin Panel</b>

Welcome to the administration dashboard. Select an option below to manage the bot.
    `;
    const options = {
        parse_mode: 'HTML',
        reply_markup: this.getAdminKeyboard()
    };
    if (messageId) {
        await this.bot.editMessageText(adminText, {
            chat_id: chatId,
            message_id: messageId,
            ...options
        }).catch(() => this.bot.sendMessage(chatId, adminText, options));
    } else {
        await this.bot.sendMessage(chatId, adminText, options);
    }
  }

  async showAdminStats(chatId) {
    const totalUsers = await this.db.getTotalUsers();
    const totalOrders = await this.db.getTotalOrders();
    const totalRevenue = await this.db.getTotalRevenue();
    const totalTransfers = await this.db.getTotalBalanceTransfers();

    const statsText = `
📊 <b>Bot Statistics</b>

👥 <b>Total Users:</b> ${totalUsers}
📦 <b>Total Orders:</b> ${totalOrders}
💰 <b>Total Revenue:</b> ₹${this.payment.formatCurrency(totalRevenue)}
🔄 <b>Total Transfers:</b> ${totalTransfers}

🕒 <b>Last Updated:</b> ${new Date().toLocaleString()}
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'admin_stats' }],
        [{ text: 'Back to Admin', callback_data: 'admin_back' }]
      ]
    };

    await this.bot.sendMessage(chatId, statsText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async showUserManagement(chatId) {
    const users = await this.db.getAllUsers(10);

    let usersText = `
🛡️ <b>User Management</b>

Recent users (latest 10):
    `;

    users.forEach((user, index) => {
      usersText += `\n${index + 1}. <b>${user.first_name || 'Unknown'}</b> (@${user.username || 'N/A'})\n`;
      usersText += `   🆔: <code>${user.user_id}</code> | 💳: ₹${user.balance} | 📦: ${user.total_orders}\n`;
    });

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔍 Search User', callback_data: 'admin_user_search' }],
        [{ text: '📋 All Users', callback_data: 'admin_user_list' }],
        [{ text: 'Back to Admin', callback_data: 'admin_back' }]
      ]
    };

    await this.bot.sendMessage(chatId, usersText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async showBalanceManagement(chatId) {
    const balanceText = `
💳 <b>Balance Management</b>

Manage user balances and deposits.
    `;

    const keyboard = {
      inline_keyboard: [
        [
          { text: 'Add Balance', callback_data: 'admin_deposit_start' },
          { text: 'Deduct Balance', callback_data: 'admin_deduct_start' }
        ],
        [
          { text: '📊 Balance Reports', callback_data: 'admin_balance_reports' }
        ],
        [{ text: 'Back to Admin', callback_data: 'admin_back' }]
      ]
    };

    await this.bot.sendMessage(chatId, balanceText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async showGiftCodeManagement(chatId) {
    const giftText = `
🎟️ <b>Gift Code Management</b>

Create and manage gift codes with custom conditions.
    `;

    const keyboard = {
      inline_keyboard: [
        [
          { text: 'Create Code', callback_data: 'admin_gift_create' },
          { text: '📋 Gift Code List', callback_data: 'admin_gift_list' }
        ],
        [{ text: 'Back to Admin', callback_data: 'admin_back' }]
      ]
    };

    await this.bot.sendMessage(chatId, giftText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  async showMonthlyDepositManagement(chatId, messageId = null) {
    const monthlyText = `
📈 <b>Monthly Deposit Management</b>

Manage and view user monthly deposits for discount tiers.
    `;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🎉 Top Depositors', callback_data: 'admin_top_depositors_0' },
          { text: '🧩 All Depositors', callback_data: 'admin_all_depositors_0' }
        ],
        [
          { text: '🏷️ Discounted Users', callback_data: 'admin_discounted_users_0' }
        ],
        [
          { text: '⏻ Reset Deposit', callback_data: 'admin_monthly_reset_start' },
          { text: '🕹️ Set Deposit', callback_data: 'admin_monthly_set_start' }
        ],
        [{ text: 'Back to Admin', callback_data: 'admin_back' }]
      ]
    };

    const options = {
        parse_mode: 'HTML',
        reply_markup: keyboard
    }

    if(messageId){
        await this.bot.editMessageText(monthlyText, { chat_id: chatId, message_id: messageId, ...options});
    } else {
        await this.bot.sendMessage(chatId, monthlyText, options);
    }
  }

    async showTopDepositors(chatId, page = 0, messageId = null) {
        const limit = 10;
        const offset = page * limit;
        const { users, total } = await this.db.getTopDepositors(limit, offset);
        const totalPages = Math.ceil(total / limit);

        let text = `🏆 <b>Top Depositors (Page ${page + 1}/${totalPages})</b>\n\n`;

        if (users.length === 0) {
            text += 'No depositors found for this month.';
        } else {
            users.forEach((user, index) => {
                text += `${offset + index + 1}. <b>${user.first_name || 'Unknown'}</b> (@${user.username || 'N/A'})\n`;
                text += `   🆔: <code>${user.user_id}</code>\n   💰: <b>₹${this.payment.formatCurrency(user.total_deposit)}</b>\n\n`;
            });
        }

        const keyboard = this.createPaginationKeyboard(page, totalPages, 'admin_top_depositors');
        keyboard.inline_keyboard.push([{ text: '🔙 Back', callback_data: 'admin_monthly' }]);

        const options = { parse_mode: 'HTML', reply_markup: keyboard };
        if(messageId){
            await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        } else {
            await this.bot.sendMessage(chatId, text, options);
        }
    }

    async showAllDepositors(chatId, page = 0, messageId = null) {
        const limit = 10;
        const offset = page * limit;
        const { users, total } = await this.db.getAllDepositors(limit, offset);
        const totalPages = Math.ceil(total / limit);

        let text = `👥 <b>All Depositors (Page ${page + 1}/${totalPages})</b>\n\n`;

        if (users.length === 0) {
            text += 'No depositors found for this month.';
        } else {
            users.forEach((user, index) => {
                text += `${offset + index + 1}. <b>${user.first_name || 'Unknown'}</b> (@${user.username || 'N/A'})\n`;
                text += `   🆔: <code>${user.user_id}</code> | 💰: ₹${this.payment.formatCurrency(user.total_deposit)}\n\n`;
            });
        }

        const keyboard = this.createPaginationKeyboard(page, totalPages, 'admin_all_depositors');
        keyboard.inline_keyboard.push([{ text: '🔙 Back', callback_data: 'admin_monthly' }]);

        const options = { parse_mode: 'HTML', reply_markup: keyboard };
         if(messageId){
            await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        } else {
            await this.bot.sendMessage(chatId, text, options);
        }
    }

    async showDiscountedUsers(chatId, page = 0, messageId = null) {
        const limit = 10;
        const offset = page * limit;
        const minDeposit = config.DISCOUNT_SETTINGS.tiers.sort((a,b) => a.deposit - b.deposit)[0]?.deposit || 0;

        const { users, total } = await this.db.getDiscountedUsers(minDeposit, limit, offset);
        const totalPages = Math.ceil(total / limit);

        let text = `🏷️ <b>Users with Active Discount (Page ${page + 1}/${totalPages})</b>\n\n`;

        if (users.length === 0) {
            text += 'No users with active discount found.';
        } else {
            users.forEach((user, index) => {
                const discountInfo = this.payment.getDiscountInfo(user.total_deposit);
                text += `${offset + index + 1}. <b>${user.first_name || 'Unknown'}</b> (@${user.username || 'N/A'})\n`;
                text += `   🆔: <code>${user.user_id}</code> | 💰: ₹${user.total_deposit}\n`;
                text += `   🎉: <b>${discountInfo.currentDiscount}% OFF</b>\n\n`;
            });
        }

        const keyboard = this.createPaginationKeyboard(page, totalPages, 'admin_discounted_users');
        keyboard.inline_keyboard.push([{ text: '🔙 Back', callback_data: 'admin_monthly' }]);

        const options = { parse_mode: 'HTML', reply_markup: keyboard };
         if(messageId){
            await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        } else {
            await this.bot.sendMessage(chatId, text, options);
        }
    }


    createPaginationKeyboard(currentPage, totalPages, callbackPrefix) {
        const keyboard = { inline_keyboard: [] };
        const row = [];

        if (currentPage > 0) {
            row.push({ text: '⬅️ Previous', callback_data: `${callbackPrefix}_${currentPage - 1}` });
        }

        if (currentPage < totalPages - 1) {
            row.push({ text: 'Next ➡️', callback_data: `${callbackPrefix}_${currentPage + 1}` });
        }

        if (row.length > 0) {
            keyboard.inline_keyboard.push(row);
        }

        return keyboard;
    }


  async handleManualDeposit(chatId) {
    this.setUserState(config.ADMIN_ID, 'admin_awaiting_deposit_user');

    await this.bot.sendMessage(chatId, `
➕ <b>Manual Deposit</b>

Please enter the User ID to deposit balance to:
    `.trim(), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Cancel', callback_data: 'admin_balance' }]
        ]
      }
    });
  }

  async handleAdminDepositUserInput(chatId, targetUserId) {
    try {
      const targetUser = await this.db.getUser(parseInt(targetUserId));

      if (!targetUser) {
        await this.bot.sendMessage(chatId, '❌ User not found.');
        return;
      }

      this.setUserState(config.ADMIN_ID, 'admin_awaiting_deposit_amount', { targetUserId: parseInt(targetUserId) });

      await this.bot.sendMessage(chatId, `
➕ <b>Manual Deposit</b>

👤 <b>User:</b> ${targetUser.first_name || 'Unknown'} (ID: ${targetUserId})
💳 <b>Current Balance:</b> ₹${this.payment.formatCurrency(targetUser.balance)}

Please enter the amount to deposit:
      `.trim(), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Cancel', callback_data: 'admin_balance' }]
          ]
        }
      });

    } catch (error) {
      console.error('Admin deposit error:', error);
      await this.bot.sendMessage(chatId, '❌ Error processing deposit.');
    }
  }

  async handleAdminDepositAmountInput(chatId, amount) {
    try {
      const userState = this.getUserState(config.ADMIN_ID);
      const targetUserId = userState.data.targetUserId;

      const depositAmount = parseFloat(amount);

      if (isNaN(depositAmount) || depositAmount <= 0) {
        await this.bot.sendMessage(chatId, '❌ Please enter a valid amount.');
        return;
      }

      await this.db.updateBalance(targetUserId, depositAmount);
      await this.db.updateMonthlyDeposit(targetUserId, depositAmount);

      const targetUser = await this.db.getUser(targetUserId);
      const monthlyDeposit = await this.db.getMonthlyDeposit(targetUserId);

      await this.bot.sendMessage(chatId, `
✅ <b>Deposit Successful!</b>

👤 <b>User:</b> ${targetUser.first_name || 'Unknown'} (ID: ${targetUserId})
💰 <b>Amount:</b> ₹${depositAmount}
💳 <b>New Balance:</b> ₹${this.payment.formatCurrency(targetUser.balance)}
📈 <b>Monthly Deposit:</b> ₹${this.payment.formatCurrency(monthlyDeposit)}

Deposit completed successfully.
      `.trim(), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Back to Admin', callback_data: 'admin_back' }]
          ]
        }
      });

      this.clearUserState(config.ADMIN_ID);

      try {
        await this.bot.sendMessage(targetUserId, `
🎉 <b>Balance Added by Admin</b>

💰 <b>Amount:</b> ₹${depositAmount}
💳 <b>Your New Balance:</b> ₹${this.payment.formatCurrency(targetUser.balance)}
📈 <b>Monthly Deposit:</b> ₹${this.payment.formatCurrency(monthlyDeposit)}

Balance added successfully by administrator.
        `.trim(), {
          parse_mode: 'HTML'
        });
      } catch (error) {
        console.error('Failed to notify user:', error);
      }

    } catch (error) {
      console.error('Admin deposit error:', error);
      await this.bot.sendMessage(chatId, '❌ Deposit failed. Please try again.');
    }
  }


  async handleChannelBlock(chatId, reason) {
    if (reason === 'channel_left') {
      await this.bot.sendMessage(chatId, `
❌ <b>Access Blocked</b>

You have left our channel! To continue using the bot:

📢 <b>Rejoin Channel:</b> ${config.CHANNEL_LINK}

After rejoining, click below to verify:
      `.trim(), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📢 Rejoin Channel', url: config.CHANNEL_LINK }],
            [{ text: '✅ Verify Again', callback_data: 'check_join' }]
          ]
        }
      });
    }
  }

  async showDepositMenu(chatId, userId) {
    const user = await this.db.getUser(userId);
    const monthlyDeposit = await this.db.getMonthlyDeposit(userId);
    const discountInfo = this.payment.getDiscountInfo(monthlyDeposit);

    let depositText = `
💶 <b>Deposit Money</b>

💰 <b>Your Balance:</b> ₹${this.payment.formatCurrency(user.balance)}
💵 <b>Monthly Deposit:</b> ₹${this.payment.formatCurrency(monthlyDeposit)}
`;

    if (discountInfo && discountInfo.currentDiscount > 0) {
      depositText += `🎁 <b>Active Discount:</b> ${discountInfo.currentDiscount}%\n`;
    }

    if (discountInfo && discountInfo.nextTier) {
      depositText += `\n🎯 Deposit ₹${discountInfo.nextTier.depositNeeded} more for ${discountInfo.nextTier.discount}% discount!\n`;
    }

    depositText += `\n<b>Select deposit amount:</b>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '₹50', callback_data: 'deposit_50' },
          { text: '₹100', callback_data: 'deposit_100' },
          { text: '₹200', callback_data: 'deposit_200' }
        ],
        [
          { text: '₹500', callback_data: 'deposit_500' },
          { text: '₹1000', callback_data: 'deposit_1000' },
          { text: 'Custom', callback_data: 'deposit_custom' }
        ],
        [
          { text: '🔙 Back', callback_data: 'main_menu' }
        ]
      ]
    };

    await this.bot.sendMessage(chatId, depositText, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

    async handleDepositAmount(query) {
    const chatId = query.message.chat.id;
    const userId = query.from.id;

    if (query.data === 'deposit_custom') {
      this.setUserState(userId, 'awaiting_custom_amount');
      await this.bot.editMessageText('💵 <b>Custom Amount</b>\n\nPlease enter the amount you want to deposit:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });
      return;
    }

    const amount = parseInt(query.data.split('_')[1]);
    await this.processDepositPayment(chatId, userId, amount, query.message.message_id);
  }

  async processDepositPayment(chatId, userId, amount, messageId = null) {
    const depositId = `DEP${Date.now()}${Math.random().toString(36).substr(2, 5)}`.toUpperCase();
    const paymentNote = `${config.FIRE_OTP_NOTE_PREFIX}${depositId}`;
    const upiLink = this.payment.generateUPILink(amount, paymentNote);

    try {
      const qrBuffer = await this.payment.generateQRCode(upiLink);

      const paymentText = `
💰 <b>Payment Invoice</b>

💳 <b>Amount:</b> ₹${amount}
🆔 <b>Deposit ID:</b> <code>${depositId}</code>

<b>Payment Methods:</b>
1. Scan QR Code below
2. Manual UPI payment

<b>After payment, send your ${config.MIN_UTR_LENGTH}-digit UTR number here.</b>
      `;

      this.setUserState(userId, 'awaiting_utr', { amount, depositId });

      if (messageId) {
          try { await this.bot.deleteMessage(chatId, messageId); } catch(e){}
      }

      await this.bot.sendPhoto(chatId, qrBuffer, {
        caption: paymentText,
        parse_mode: 'HTML',
        reply_markup: this.getCancelKeyboard()
      });

    } catch (error) {
      console.error('QR code error:', error);
      const paymentText = `
💰 <b>Payment Request</b>

📱 <b>UPI ID:</b> <code>${config.UPI_ID}</code>
👤 <b>UPI Name:</b> ${config.UPI_NAME}
💳 <b>Amount:</b> ₹${amount}
🆔 <b>Deposit ID:</b> <code>${depositId}</code>
📝 <b>Note:</b> <code>${paymentNote}</code>

<b>UPI Link:</b> <code>${upiLink}</code>

<b>After payment, send your ${config.MIN_UTR_LENGTH}-digit UTR number here.</b>
      `;
      if (messageId) {
          try { await this.bot.deleteMessage(chatId, messageId); } catch(e){}
      }
      await this.bot.sendMessage(chatId, paymentText, {
        parse_mode: 'HTML',
        reply_markup: this.getCancelKeyboard()
      });
    }
  }

  async handleAdminApproval(query) {
    const chatId = query.message.chat.id;
    const [action, requestId] = query.data.split('_');

    console.log(`🔍 Debug: Admin approval called - Action: ${action}, RequestID: ${requestId}, ChatID: ${chatId}`);

    if (query.from.id !== config.ADMIN_ID) {
      console.log('❌ Unauthorized access attempt');
      await this.bot.answerCallbackQuery(query.id, { text: '❌ Unauthorized' });
      return;
    }

    try {
      console.log(`🔍 Debug: Fetching request info for ID: ${requestId}`);
      const requestInfo = await this.db.getTopupRequestInfo(requestId);
      
      if (!requestInfo) {
        console.log('❌ Request not found in database');
        await this.bot.editMessageText('❌ Request not found or already processed', {
          chat_id: chatId,
          message_id: query.message.message_id
        });
        return;
      }

      console.log(`🔍 Debug: Request found - User: ${requestInfo.user_id}, Amount: ${requestInfo.amount}, Status: ${requestInfo.status}`);

      if (requestInfo.status !== 'pending') {
        console.log(`❌ Request already processed - Status: ${requestInfo.status}`);
        await this.bot.editMessageText('❌ Request not found or already processed', {
          chat_id: chatId,
          message_id: query.message.message_id
        });
        return;
      }

      const { user_id, amount, utr } = requestInfo;

      console.log(`🔄 Processing ${action} for request ${requestId}, User: ${user_id}, Amount: ${amount}`);
      
      if (action === 'approve') {
        console.log(`✅ Approving deposit - User: ${user_id}, Amount: ${amount}`);
    
        const userBefore = await this.db.getUser(user_id);
        console.log(`🔍 Balance before: ₹${userBefore.balance}`);
        
        await this.db.updateBalance(user_id, amount);
        await this.db.updateMonthlyDeposit(user_id, amount);
        await this.db.updateTopupStatus(requestId, 'approved');
        
        const userAfter = await this.db.getUser(user_id);
        const monthlyDeposit = await this.db.getMonthlyDeposit(user_id);
        
        console.log(`✅ Balance after: ₹${userAfter.balance}, Monthly Deposit: ₹${monthlyDeposit}`);

        if (config.REFERRAL_SETTINGS.enabled && amount >= config.REFERRAL_SETTINGS.min_deposit_for_commission) {
          try {
            console.log(`💰 Checking for referral commission...`);
            const referral = await this.db.getReferralByReferredId(user_id);
            
            if (referral && referral.referrer_id !== user_id) {
              const commission = (amount * config.REFERRAL_SETTINGS.commission_percent) / 100;
              
              console.log(`💰 Processing referral commission:`);
              console.log(`- Referrer: ${referral.referrer_id}`);
              console.log(`- Referred: ${user_id}`);
              console.log(`- Deposit: ₹${amount}`);
              console.log(`- Commission: ₹${commission}`);
        
              const referrerBefore = await this.db.getUser(referral.referrer_id);
              console.log(`🔍 Referrer balance before: ₹${referrerBefore.balance}`);
              
              await this.db.updateBalance(referral.referrer_id, commission);
              
              await this.db.addReferralEarning({
                referrer_id: referral.referrer_id,
                referred_id: user_id,
                deposit_amount: amount,
                commission_amount: commission,
                commission_percent: config.REFERRAL_SETTINGS.commission_percent
              });

              const referrerAfter = await this.db.getUser(referral.referrer_id);
              console.log(`✅ Referrer balance after: ₹${referrerAfter.balance}`);
              console.log(`✅ Commission processed successfully`);

              try {
                await this.bot.sendMessage(referral.referrer_id,
                  `🎊 <b>Referral Commission Earned!</b>\n\n` +
                  `💻 From: ${userAfter.first_name || 'User'} (ID: ${user_id})\n` +
                  `💳 Deposit: ₹${amount}\n` +
                  `🌱 Commission: ₹${commission} (${config.REFERRAL_SETTINGS.commission_percent}%)\n` +
                  `🔴 Your New Balance: ₹${referrerAfter.balance}\n\n` +
                  `Keep referring to earn more! 🎊`,
                  { parse_mode: 'HTML' }
                );
                console.log(`✅ Referrer notified successfully`);
              } catch (error) {
                console.error('Referrer commission notification failed:', error);
              }
            } else {
              console.log(`ℹ️ No referral found or self-referral for user: ${user_id}`);
            }
          } catch (error) {
            console.error('Referral commission processing error:', error);
          }
        } else {
          console.log(`ℹ️ Referral system disabled or amount too low for commission`);
        }

        if (this.notifier) {
          await this.notifier.depositApproved({
            user_id: user_id,
            amount: amount,
            utr: utr
          }, userAfter.balance);
        }
        
        try {
          await this.bot.sendMessage(user_id, `
✅ <b>Deposit Approved</b>

💳 Amount: ₹${amount}
🔢 UTR: ${utr}
💰 New Balance: ₹${userAfter.balance}
💵 Monthly Deposit: ₹${monthlyDeposit}
🆔 Request ID: ${requestId}

Your balance has been updated! 🎉
          `.trim(), { parse_mode: 'HTML' });
        } catch (error) {
          console.error('User notification error:', error);
        }

        await this.bot.editMessageText(`✅ Approved deposit of ₹${amount} for user ${user_id}\n\n💰 New Balance: ₹${userAfter.balance}\n💵 Monthly Deposit: ₹${monthlyDeposit}\n🆔 Request ID: ${requestId}`, {
          chat_id: chatId,
          message_id: query.message.message_id
        });

        await this.bot.answerCallbackQuery(query.id, { text: '✅ Deposit approved successfully!' });

      } else if (action === 'reject') {
        console.log(`❌ Rejecting deposit - User: ${user_id}, Amount: ${amount}`);
        
        await this.db.updateTopupStatus(requestId, 'rejected');

        if (this.notifier) {
          await this.notifier.depositRejected({
            user_id: user_id,
            amount: amount,
            utr: utr
          });
        }

        try {
          await this.bot.sendMessage(user_id, `
❌ <b>Deposit Rejected</b>

💳 Amount: ₹${amount}
🔢 UTR: ${utr}
🆔 Request ID: ${requestId}

Please contact admin for assistance.
          `.trim(), { parse_mode: 'HTML' });
        } catch (error) {
          console.error('User notification error:', error);
        }

        await this.bot.editMessageText(`❌ Rejected deposit of ₹${amount} for user ${user_id}\n🆔 Request ID: ${requestId}`, {
          chat_id: chatId,
          message_id: query.message.message_id
        });

        await this.bot.answerCallbackQuery(query.id, { text: '❌ Deposit rejected!' });
      }
    } catch (error) {
      console.error('Admin approval error:', error);
      await this.bot.editMessageText('❌ Error processing request: ' + error.message, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
      await this.bot.answerCallbackQuery(query.id, { text: '❌ Error processing request' });
    }
  }

  async handleGiftRedeem(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const access = await this.verifyUserAccess(userId);
    if (!access.allowed) {
      await this.handleChannelBlock(chatId, access.reason);
      return;
    }

    this.setUserState(userId, 'awaiting_gift_code');

    await this.bot.sendMessage(chatId, `
🎟️ <b>Redeem Gift Code</b>

Please enter your gift code:

Gift codes are 8 characters long.
    `.trim(), {
      parse_mode: 'HTML',
      reply_markup: this.getCancelKeyboard()
    });
  }

  async handleGiftCodeInput(chatId, userId, code) {
    try {
        const giftCode = await this.db.getGiftCodeWithCondition(code.toUpperCase());

        if (!giftCode) {
            await this.bot.sendMessage(chatId, '❌ Invalid gift code');
            return;
        }

        if (giftCode.min_deposit > 0) {
            const meetsCondition = await this.db.checkUserDepositCondition(userId, giftCode.min_deposit);
            if (!meetsCondition) {
                const monthlyDeposit = await this.db.getMonthlyDeposit(userId);
                await this.bot.sendMessage(chatId, 
                    `❌ <b>Gift Code Requirement Not Met</b>\n\n` +
                    `💰 Required Monthly Deposit: ₹${giftCode.min_deposit}\n` +
                    `💳 Your Monthly Deposit: ₹${monthlyDeposit}\n\n` +
                    `Please deposit more to redeem this gift code.`,
                    { parse_mode: 'HTML' }
                );
                return;
            }
        }

        if (giftCode.expires_at && new Date(giftCode.expires_at) < new Date()) {
            await this.bot.sendMessage(chatId, '❌ This gift code has expired.');
            return;
        }


        if (giftCode.max_uses > 0 && giftCode.used_count >= giftCode.max_uses) {
            await this.bot.sendMessage(chatId, '❌ This gift code has reached its maximum uses.');
            return;
        }


        const userHasUsed = await this.db.checkIfUserUsedGiftCode(code.toUpperCase(), userId);
        if (userHasUsed) {
            await this.bot.sendMessage(chatId, '❌ You have already redeemed this gift code.');
            return;
        }

        const success = await this.db.useGiftCode(code.toUpperCase(), userId);

        if (success) {
            await this.db.updateBalance(userId, giftCode.amount);
            const user = await this.db.getUser(userId);

            await this.bot.sendMessage(chatId, 
                `🎉 <b>Gift Code Redeemed!</b>\n\n` +
                `💰 <b>Amount:</b> ₹${giftCode.amount}\n` +
                `🔤 <b>Code:</b> <code>${code.toUpperCase()}</code>\n` +
                `💳 <b>New Balance:</b> ₹${user.balance}\n` +
                `${giftCode.min_deposit > 0 ? `📋 <b>Condition:</b> Min. ₹${giftCode.min_deposit} deposit` : ''}\n\n` +
                `✅ <b>Balance updated successfully!</b>`,
                { parse_mode: 'HTML' }
            );


            await this.notifier.giftCodeRedeemed(userId, code.toUpperCase(), giftCode.amount, user.balance);

        } else {
            await this.bot.sendMessage(chatId, '❌ Failed to redeem gift code. Please try again.');
        }

    } catch (error) {
        console.error('Gift code error:', error);
        await this.bot.sendMessage(chatId, '❌ Error processing gift code. Please try again.');
    }

    this.clearUserState(userId);
}

    async handleMessage(msg) {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim();
    const userState = this.getUserState(userId);
    await this.db.updateUserProfile(userId, msg.from.first_name, msg.from.username);
    if (text === '🛒 Buy OTP') {
      await this.showAllServices(chatId, userId, 0);
    }
    else if (text === '💵 Deposit') {
      await this.showDepositMenu(chatId, userId);
    }
    else if (text === '🎟️ Redeem Gift') {
      await this.handleGiftRedeem(msg);
    }
    else if (text === '👤 Profile') {
      await this.showUserProfile(chatId, userId);
    }
    else if (text === '👥 Refer & Earn') {
    await this.handleReferralCommand(msg);
    }
    else if (text === '🏷️ Discount') {
      await this.showDiscountInfo(chatId, userId);
    }
    else if (text === '📊 My Orders') {
      await this.showMyOrders(chatId, userId);
    }
    else if (text === '🔴  Support') {
      await this.showHelp(chatId);
    }
    else if (text === 'Back 🔄') {
      this.clearUserState(userId);
      await this.showMainMenu(chatId, userId);
    }
    else if (text === '📚 Statistics' && userId === config.ADMIN_ID) {
      await this.showAdminStats(chatId);
    }
    else if (text === '🛡️ User Management' && userId === config.ADMIN_ID) {
      await this.showUserManagement(chatId);
    }
    else if (text === '💳 Balance Management' && userId === config.ADMIN_ID) {
      await this.showBalanceManagement(chatId);
    }
    else if (text === '📢 Broadcast' && userId === config.ADMIN_ID) {
    await this.handleBroadcastCommand(msg);
    }
    else if (text === '🎟️ Gift Codes' && userId === config.ADMIN_ID) {
      await this.showGiftCodeManagement(chatId);
    }
    else if (text === '📈 Monthly Deposits' && userId === config.ADMIN_ID) {
      await this.showMonthlyDepositManagement(chatId);
    }
    else if (text === '⚙️ Settings' && userId === config.ADMIN_ID) {
      await this.bot.sendMessage(chatId, '⚙️ <b>Admin Settings</b>\n\nSettings panel coming soon...', { parse_mode: 'HTML' });
    }
    else if (text === 'Main Menu' && userId === config.ADMIN_ID) {
      await this.showMainMenu(chatId, userId);
    }
    else if (userState?.state === 'awaiting_custom_amount') {
      await this.handleCustomAmountInput(chatId, userId, text);
    }
    else if (userState?.state === 'awaiting_utr') {
      await this.handleUTRInput(chatId, userId, text, userState.data.amount, userState.data.depositId);
    }
    else if (userState?.state === 'awaiting_gift_code') {
      await this.handleGiftCodeInput(chatId, userId, text);
    }
    else if (userState?.state === 'awaiting_search') {
      await this.showSearchResults(chatId, userId, text);
    }
    else if (userState?.state === 'awaiting_transfer_user') {
      await this.handleTransferUserInput(chatId, userId, text);
    }
    else if (userState?.state === 'awaiting_transfer_amount') {
      await this.handleTransferAmountInput(chatId, userId, text);
    }
    else if (userState?.state === 'admin_awaiting_deposit_user') {
      await this.handleAdminDepositUserInput(chatId, text);
    }
    else if (userState?.state === 'admin_awaiting_deposit_amount') {
      await this.handleAdminDepositAmountInput(chatId, text);
    }
    else if (userState?.state === 'admin_awaiting_deduct_user') {
      await this.handleAdminDeductUserInput(chatId, text);
    }
    else if (userState?.state === 'admin_awaiting_deduct_amount') {
      await this.handleAdminDeductAmountInput(chatId, text);
    }
    else if (userState?.state === 'admin_awaiting_reset_user') {
      await this.handleAdminResetUserInput(chatId, text);
    }
    else if (userState?.state === 'admin_awaiting_set_user') {
      await this.handleAdminSetUserInput(chatId, text);
    }
    else if (userState?.state === 'admin_awaiting_set_amount') {
      await this.handleAdminSetAmountInput(chatId, text);
    }
    else if (userState?.state === 'admin_awaiting_broadcast') {
    await this.handleBroadcastMessageInput(chatId, text);
    }
    else if (userState?.state === 'admin_awaiting_gift_amount') {
      await this.handleAdminGiftAmountInput(chatId, text);
    }
    else if (userState?.state === 'admin_awaiting_gift_uses') {
      await this.handleAdminGiftUsesInput(chatId, text);
    }
    else if (userState?.state === 'admin_awaiting_gift_min_deposit') {
  await this.handleAdminGiftMinDepositInput(chatId, text);
}
    else if (userState?.state === 'admin_awaiting_search_user') {
      await this.handleAdminSearchUserInput(chatId, text);
    }
    else {
      await this.handleSearchCommand(msg, text);
    }
  }

    async handleAdminDeductUserInput(chatId, targetUserId) {
        try {
            const targetUser = await this.db.getUser(parseInt(targetUserId));
            if (!targetUser) {
                await this.bot.sendMessage(chatId, '❌ User not found.');
                return;
            }
            this.setUserState(config.ADMIN_ID, 'admin_awaiting_deduct_amount', { targetUserId: parseInt(targetUserId) });
            await this.bot.sendMessage(chatId, `
➖ <b>Deduct Balance</b>

👤 <b>User:</b> ${targetUser.first_name || 'Unknown'} (ID: ${targetUserId})
💳 <b>Current Balance:</b> ₹${this.payment.formatCurrency(targetUser.balance)}

Please enter the amount to deduct:
            `.trim(), { parse_mode: 'HTML' });
        } catch (error) {
            await this.bot.sendMessage(chatId, '❌ Error processing request.');
        }
    }

    async handleAdminDeductAmountInput(chatId, amount) {
        try {
            const userState = this.getUserState(config.ADMIN_ID);
            const targetUserId = userState.data.targetUserId;
            const deductAmount = parseFloat(amount);
            if (isNaN(deductAmount) || deductAmount <= 0) {
                await this.bot.sendMessage(chatId, '❌ Please enter a valid amount.');
                return;
            }
            await this.db.updateBalance(targetUserId, -deductAmount);
            const targetUser = await this.db.getUser(targetUserId);
            await this.bot.sendMessage(chatId, `
✅ <b>Deduction Successful!</b>

👤 <b>User:</b> ID ${targetUserId}
💰 <b>Amount Deducted:</b> ₹${deductAmount}
💳 <b>New Balance:</b> ₹${this.payment.formatCurrency(targetUser.balance)}
            `.trim(), { parse_mode: 'HTML' });
            this.clearUserState(config.ADMIN_ID);
            await this.bot.sendMessage(targetUserId, `
📢 <b>Balance Update</b>

An amount of ₹${deductAmount} has been deducted from your account by an administrator.
Your new balance is ₹${this.payment.formatCurrency(targetUser.balance)}.
            `.trim(), { parse_mode: 'HTML' }).catch(e => {});
        } catch (error) {
            await this.bot.sendMessage(chatId, '❌ Deduction failed.');
        }
    }

    async handleAdminResetUserInput(chatId, targetUserId) {
        try {
            const targetUser = await this.db.getUser(parseInt(targetUserId));
            if (!targetUser) {
                await this.bot.sendMessage(chatId, '❌ User not found.');
                return;
            }
            await this.db.resetMonthlyDeposit(parseInt(targetUserId));
            await this.bot.sendMessage(chatId, `✅ Monthly deposit for user ${targetUserId} has been reset to 0.`, { parse_mode: 'HTML' });
            this.clearUserState(config.ADMIN_ID);
        } catch (error) {
            await this.bot.sendMessage(chatId, '❌ Error processing request.');
        }
    }

    async handleAdminSetUserInput(chatId, targetUserId) {
        try {
            const targetUser = await this.db.getUser(parseInt(targetUserId));
            if (!targetUser) {
                await this.bot.sendMessage(chatId, '❌ User not found.');
                return;
            }
            this.setUserState(config.ADMIN_ID, 'admin_awaiting_set_amount', { targetUserId: parseInt(targetUserId) });
            const monthlyDeposit = await this.db.getMonthlyDeposit(parseInt(targetUserId));
            await this.bot.sendMessage(chatId, `
📊 <b>Set Monthly Deposit</b>

👤 <b>User:</b> ID ${targetUserId}
📈 <b>Current Monthly Deposit:</b> ₹${this.payment.formatCurrency(monthlyDeposit)}

Please enter the new total monthly deposit amount:
            `.trim(), { parse_mode: 'HTML' });
        } catch (error) {
            await this.bot.sendMessage(chatId, '❌ Error processing request.');
        }
    }

    async handleAdminSetAmountInput(chatId, amount) {
        try {
            const userState = this.getUserState(config.ADMIN_ID);
            const targetUserId = userState.data.targetUserId;
            const newAmount = parseFloat(amount);
            if (isNaN(newAmount) || newAmount < 0) {
                await this.bot.sendMessage(chatId, '❌ Please enter a valid non-negative amount.');
                return;
            }
            await this.db.setMonthlyDeposit(targetUserId, newAmount);
            await this.bot.sendMessage(chatId, `✅ Monthly deposit for user ${targetUserId} has been set to ₹${newAmount}.`);
            this.clearUserState(config.ADMIN_ID);
        } catch (error) {
            await this.bot.sendMessage(chatId, '❌ Failed to set amount.');
        }
    }

    async handleAdminGiftAmountInput(chatId, amount) {
        const giftAmount = parseFloat(amount);
        if (isNaN(giftAmount) || giftAmount <= 0) {
            await this.bot.sendMessage(chatId, '❌ Please enter a valid amount.');
            return;
        }
        this.setUserState(config.ADMIN_ID, 'admin_awaiting_gift_uses', { amount: giftAmount });
        await this.bot.sendMessage(chatId, `
🎟️ <b>Create Gift Code</b>

✅ <b>Amount:</b> ₹${giftAmount}

How many times can this code be used? (Enter a number, or 0 for unlimited)
        `.trim(), { parse_mode: 'HTML' });
    }

    async handleAdminGiftUsesInput(chatId, uses) {
    const maxUses = parseInt(uses);
    if (isNaN(maxUses) || maxUses < 0) {
        await this.bot.sendMessage(chatId, '❌ Please enter a valid number of uses (0 or more).');
        return;
    }
    
    const userState = this.getUserState(config.ADMIN_ID);
    const amount = userState.data.amount;
    
    this.setUserState(config.ADMIN_ID, 'admin_awaiting_gift_min_deposit', { 
        amount: amount, 
        maxUses: maxUses 
    });

    await this.bot.sendMessage(chatId, 
        `🎟️ <b>Create Gift Code</b>\n\n` +
        `✅ <b>Amount:</b> ₹${amount}\n` +
        `🔄 <b>Max Uses:</b> ${maxUses === 0 ? 'Unlimited' : maxUses}\n\n` +
        `Set minimum monthly deposit requirement (Enter 0 for no condition):`,
        { parse_mode: 'HTML' }
    );
}

async handleAdminGiftMinDepositInput(chatId, minDeposit) {
    const minDepositAmount = parseFloat(minDeposit);
    if (isNaN(minDepositAmount) || minDepositAmount < 0) {
        await this.bot.sendMessage(chatId, '❌ Please enter a valid minimum deposit amount (0 or more).');
        return;
    }
    
    const userState = this.getUserState(config.ADMIN_ID);
    const amount = userState.data.amount;
    const maxUses = userState.data.maxUses;
    const newCode = this.payment.generateGiftCode();

    await this.db.createGiftCodeWithCondition({
        code: newCode,
        amount,
        createdBy: config.ADMIN_ID,
        maxUses,
        minDeposit: minDepositAmount
    });

    await this.bot.sendMessage(chatId, 
        `✅ <b>Gift Code Created!</b>\n\n` +
        `🏷️ <b>Code:</b> <code>${newCode}</code>\n` +
        `💳 <b>Amount:</b> ₹${amount}\n` +
        `🔄 <b>Max Uses:</b> ${maxUses === 0 ? 'Unlimited' : maxUses}\n` +
        `📋 <b>Min Deposit:</b> ₹${minDepositAmount}\n\n` +
        `Only users with ₹${minDepositAmount}+ monthly deposit can redeem this code.`,
        { parse_mode: 'HTML' }
    );
    
    this.clearUserState(config.ADMIN_ID);
}


  async handleCustomAmountInput(chatId, userId, text) {
    try {
      const amount = parseInt(text);

      if (!this.payment.validateAmount(amount)) {
        await this.bot.sendMessage(chatId, `❌ Invalid amount. Minimum deposit is ₹${config.MIN_DEPOSIT_AMOUNT} and must be a whole number.`);
        return;
      }

      this.clearUserState(userId);
      await this.processDepositPayment(chatId, userId, amount);

    } catch (error) {
      await this.bot.sendMessage(chatId, '❌ Please enter a valid number');
    }
  }

  async handleUTRInput(chatId, userId, utr, amount, depositId) {
    if (!this.payment.validateUTR(utr)) {
      await this.bot.sendMessage(chatId, `❌ UTR must be at least ${config.MIN_UTR_LENGTH} digits`);
      return;
    }

    const isDuplicate = await this.db.checkDuplicateUTR(utr);
    if (isDuplicate) {
      await this.bot.sendMessage(chatId, '❌ This UTR has already been used');
      this.clearUserState(userId);
      return;
    }

    const requestId = await this.db.logTopupRequest(userId, amount, utr, 'pending');
    await this.notifier.depositRequested({
    user_id: userId,
    amount: amount,
    utr: utr,
    depositId: depositId
  });

    if (!requestId) {
      await this.bot.sendMessage(chatId, '❌ Error processing request');
      this.clearUserState(userId);
      return;
    }
    const user = await this.db.getUser(userId);

    const adminText = `
🆕 <b>New Deposit Request</b>

👤 <b>User:</b> ${user.first_name || ''} (@${user.username || 'N/A'})
🆔 <b>User ID:</b> <code>${userId}</code>
💳 <b>Amount:</b> ₹${amount}
🔢 <b>UTR:</b> <code>${utr}</code>
🏷️ <b>Deposit ID:</b> <code>${depositId}</code>
REQ-ID: ${requestId}
    `;

    const adminKeyboard = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `approve_${requestId}` },
          { text: '❌ Reject', callback_data: `reject_${requestId}` }
        ]
      ]
    };

    try {
      await this.bot.sendMessage(config.ADMIN_ID, adminText, {
        parse_mode: 'HTML',
        reply_markup: adminKeyboard
      });
    } catch (error) {
      console.error('Admin notification error:', error);
    }

    await this.bot.sendMessage(chatId, `
✅ <b>Deposit Request Submitted</b>

💳 Amount: ₹${amount}
🔢 UTR: ${utr}
🆔 Request ID: ${requestId}
🏷️ Deposit ID: ${depositId}

⏳ Status: Pending Approval

Your balance will be updated after verification.
    `.trim(), {
      parse_mode: 'HTML',
      reply_markup: this.getMainKeyboard()
    });

    this.clearUserState(userId);
  }

  async showMyOrders(chatId, userId) {

  await this.db.cleanupExpiredOrders();
  
  const activeOrders = await this.db.getActiveOrders(userId);
  const orderHistory = await this.db.getUserOrders(userId);
  const user = await this.db.getUser(userId);

  let ordersText = '📊 <b>Your Orders</b>\n\n';

  if (activeOrders.length > 0) {
    ordersText += '<b>Active Orders:</b>\n';
    activeOrders.forEach(order => {
      const expiresAt = new Date(order.expires_at);
      const now = new Date();
      const timeDiff = expiresAt - now;
      
      let timeText = '';
      if (timeDiff <= 0) {
      } else {
        const minutesLeft = Math.max(0, Math.floor(timeDiff / (1000 * 60)));
        const hoursLeft = Math.floor(minutesLeft / 60);
        const remainingMinutes = minutesLeft % 60;
        
        if (hoursLeft > 0) {
          timeText = `⏰ Expires in: ${hoursLeft}h ${remainingMinutes}m`;
        } else {
          timeText = `⏰ Expires in: ${minutesLeft}m`;
        }
      }
      
      ordersText += `• ${order.product} - <code>${order.phone}</code> (ID: ${order.order_id})\n`;
      ordersText += `  ${timeText}\n\n`;
    });
  } else {
    ordersText += '❌ <b>No active orders</b>\n\n';
  }

  if (orderHistory.length > 0) {
    ordersText += '📋 <b>Recent Orders:</b>\n';
    orderHistory.slice(0, 5).forEach(order => {
      const statusIcon = order.status === 'completed' ? '✅' : order.status === 'cancelled' ? '❌' : '🟡';
      let orderText = `${statusIcon} ${order.service} - ${order.phone} - ₹${order.price}`;

      if (order.discount_applied > 0) {
        orderText += ` (Saved: ₹${this.payment.formatCurrency(order.discount_applied)})`;
      }

      ordersText += orderText + '\n';
      if (order.otp_code) {
        ordersText += `  🔐 OTP: <code>${order.otp_code}</code>\n`;
      }
      ordersText += '\n';
    });
  } else {
    ordersText += '❌ <b>No order history</b>\n';
  }

  ordersText += `\n💰 <b>Current Balance:</b> ₹${this.payment.formatCurrency(user.balance)}`;

  await this.bot.sendMessage(chatId, ordersText, {
    parse_mode: 'HTML',
    reply_markup: this.getMainKeyboard()
  });
}

  async showHelp(chatId) {
    const helpText = `
❓ <b>Help & Support</b>

<b>How to use:</b>
1. 💵 Deposit money first
2. 🛒 Choose a service
3. 📱 Get phone number
4. 🔐 Receive OTP

<b>Order Rules:</b>
• ⏰ 15 minutes time limit
• 🔒 Cancel locked for first 2 minutes
• ✅ OTP guaranteed or refund

<b>Search Tips:</b>
• Type any service name directly

<b>Support:</b>
📞 Contact admin for help`;

      
    const inlineKeyboard = {
        inline_keyboard: [
            [
                { 
                    text: 'Contact Support 📞', 
                    url: 'https://t.me/gt_verified' 
                }
            ]
        ]
    };

    await this.bot.sendMessage(chatId, helpText, {
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard
    });
  }

  async handleBalance(msg) {
    const user = await this.db.getUser(msg.from.id);
    const monthlyDeposit = await this.db.getMonthlyDeposit(msg.from.id);
    const discountInfo = this.payment.getDiscountInfo(monthlyDeposit);

    let balanceText = `
💳 <b>Account Balance</b> 🇮🇳

🤖 <b>Your Balance:</b> ₹${this.payment.formatCurrency(user.balance)}
💰 <b>Monthly Deposit:</b> ₹${this.payment.formatCurrency(monthlyDeposit)}
`;

    if (discountInfo && discountInfo.currentDiscount > 0) {
      balanceText += `🎁 <b>Active Discount:</b> ${discountInfo.currentDiscount}%\n`;
    }

    if (discountInfo && discountInfo.nextTier) {
      balanceText += `\n🎯 Deposit ₹${discountInfo.nextTier.depositNeeded} more for ${discountInfo.nextTier.discount}% discount!`;
    }

    await this.bot.sendMessage(msg.chat.id, balanceText.trim(), {
      parse_mode: 'HTML',
      reply_markup: this.getMainKeyboard()
    });
  }

  async handleAddMoney(msg) {
    await this.showDepositMenu(msg.chat.id, msg.from.id);
  }

async handleBroadcastCommand(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId !== config.ADMIN_ID) {
    await this.bot.sendMessage(chatId, '❌ Unauthorized access.');
    return;
  }

  this.setUserState(userId, 'admin_awaiting_broadcast');
  
  await this.bot.sendMessage(chatId, `
📢 <b>Broadcast Message</b>

Please enter your broadcast message:

<b>Formatting:</b>
• Use HTML formatting
• Maximum 4096 characters
• Supports emojis

<b>Available tags:</b>
• <code>{name}</code> - User's first name
• <code>{username}</code> - User's username
• <code>{user_id}</code> - User ID
• <code>{balance}</code> - User's balance
  `.trim(), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '❌ Cancel', callback_data: 'admin_back' }]
      ]
    }
  });
}

async handleBroadcastCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  if (userId !== config.ADMIN_ID) {
    await this.bot.answerCallbackQuery(query.id, { text: '❌ Unauthorized' });
    return;
  }

  if (data === 'broadcast_confirm') {
    await this.sendBroadcastToAllUsers(chatId, query.message.message_id);
  } else if (data === 'broadcast_cancel') {
    await this.bot.editMessageText('❌ Broadcast cancelled.', {
      chat_id: chatId,
      message_id: query.message.message_id
    });
    this.clearUserState(userId);
  }
}

async handleBroadcastMessageInput(chatId, message) {
  try {
    if (message.length > 4096) {
      await this.bot.sendMessage(chatId, '❌ Message too long. Maximum 4096 characters allowed.');
      return;
    }

    this.setUserState(config.ADMIN_ID, 'admin_broadcast_ready', { message });

    const previewMessage = `
📢 <b>Broadcast Preview</b>

${message}

────────────────
<b>This message will be sent to all users.</b>

Confirm broadcast?
    `.trim();

    await this.bot.sendMessage(chatId, previewMessage, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Send Broadcast', callback_data: 'broadcast_confirm' },
            { text: '❌ Cancel', callback_data: 'broadcast_cancel' }
          ]
        ]
      }
    });

  } catch (error) {
    console.error('Broadcast input error:', error);
    await this.bot.sendMessage(chatId, '❌ Error processing broadcast message.');
  }
}

async sendBroadcastToAllUsers(adminChatId, messageId) {
  try {
    const userState = this.getUserState(config.ADMIN_ID);
    if (!userState || !userState.data.message) {
      await this.bot.editMessageText('❌ Broadcast session expired.', {
        chat_id: adminChatId,
        message_id: messageId
      });
      return;
    }

    const broadcastMessage = userState.data.message;
    const users = await this.db.getAllUsers();

    await this.bot.editMessageText('🔄 <b>Sending Broadcast...</b>\n\n⏳ Please wait, this may take a while.', {
      chat_id: adminChatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });

    let successCount = 0;
    let failCount = 0;
    const totalUsers = users.length;

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      
      try {

        let personalizedMessage = broadcastMessage
          .replace(/{name}/g, user.first_name || 'User')
          .replace(/{username}/g, user.username ? `@${user.username}` : 'N/A')
          .replace(/{user_id}/g, user.user_id)
          .replace(/{balance}/g, user.balance || '0');

        await this.bot.sendMessage(user.user_id, personalizedMessage, {
          parse_mode: 'HTML'
        });
        
        successCount++;
        
  
        if (i % 10 === 0) {
          await this.bot.editMessageText(
            `🔄 <b>Sending Broadcast...</b>\n\n` +
            `📊 Progress: ${i + 1}/${totalUsers}\n` +
            `✅ Success: ${successCount}\n` +
            `❌ Failed: ${failCount}`,
            {
              chat_id: adminChatId,
              message_id: messageId,
              parse_mode: 'HTML'
            }
          );
        }
    
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`Failed to send to user ${user.user_id}:`, error.message);
        failCount++;
      }
    }

    const resultMessage = `
✅ <b>Broadcast Completed!</b>

📊 <b>Results:</b>
• Total Users: ${totalUsers}
• ✅ Success: ${successCount}
• ❌ Failed: ${failCount}
• 📈 Success Rate: ${((successCount / totalUsers) * 100).toFixed(1)}%

⏰ Completed at: ${new Date().toLocaleString()}
    `.trim();

    await this.bot.editMessageText(resultMessage, {
      chat_id: adminChatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Back to Admin', callback_data: 'admin_back' }]
        ]
      }
    });

    this.clearUserState(config.ADMIN_ID);

  } catch (error) {
    console.error('Broadcast error:', error);
    await this.bot.editMessageText('❌ Broadcast failed: ' + error.message, {
      chat_id: adminChatId,
      message_id: messageId
    });
  }
}

  cleanup() {
    if (this.channelCheckInterval) {
      clearInterval(this.channelCheckInterval);
    }

    for (const [orderId, job] of this.activeJobs) {
      if (job.interval) {
        clearInterval(job.interval);
      }
      if (job.cancelUpdateInterval) {
        clearInterval(job.cancelUpdateInterval);
      }
    }
  }
}

const bot = new OTPBot();

process.on('SIGINT', () => {
  console.log('🛑 Shutting down bot gracefully...');
  bot.cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down bot gracefully...');
  bot.cleanup();
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Promise Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});
