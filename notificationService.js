const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');

class NotificationService {
  constructor() {
    this.bot = new TelegramBot(config.NOTIFICATION_BOT_TOKEN, { polling: false });
    this.chatId = config.NOTIFICATION_CHAT_ID;
  }

  async sendNotification(message) {
    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'HTML'
      });
    } catch (error) {
      console.error('❌ Notification send error:', error.message);
    }
  }

  async userRegistered(userId, firstName, username) {
    const message = `👤 <b>New User Registered</b>\n\n🆔 User ID: <code>${userId}</code>\n👤 Name: ${firstName}\n📱 Username: @${username || 'N/A'}\n⏰ Time: ${new Date().toLocaleString()}`;
    await this.sendNotification(message);
  }

  async orderPlaced(orderData) {
    const { user_id, service, phone, price, order_id, original_price, discount_applied } = orderData;
    const message = `🛒 <b>New Order Placed</b>\n\n🆔 User ID: <code>${user_id}</code>\n🛍️ Service: ${service}\n📱 Number: <code>${phone}</code>\n💰 Price: ₹${price}\n🆔 Order ID: ${order_id}${discount_applied > 0 ? `\n🎁 Discount: ₹${discount_applied} (Original: ₹${original_price})` : ''}\n⏰ Time: ${new Date().toLocaleString()}`;
    await this.sendNotification(message);
  }

  async otpReceived(orderData, otpCode) {
    const { user_id, service, phone, order_id } = orderData;
    const message = `✅ <b>OTP Received</b>\n\n🆔 User ID: <code>${user_id}</code>\n🛍️ Service: ${service}\n📱 Number: <code>${phone}</code>\n🔐 OTP: <code>${otpCode}</code>\n🆔 Order ID: ${order_id}\n⏰ Time: ${new Date().toLocaleString()}`;
    await this.sendNotification(message);
  }

  async depositRequested(depositData) {
    const { user_id, amount, utr, depositId } = depositData;
    const message = `💵 <b>Deposit Requested</b>\n\n🆔 User ID: <code>${user_id}</code>\n💰 Amount: ₹${amount}\n🔢 UTR: ${utr}\n🏷️ Deposit ID: ${depositId}\n⏰ Time: ${new Date().toLocaleString()}`;
    await this.sendNotification(message);
  }

  async depositApproved(depositData, newBalance) {
    const { user_id, amount, utr } = depositData;
    const message = `✅ <b>Deposit Approved</b>\n\n🆔 User ID: <code>${user_id}</code>\n💰 Amount: ₹${amount}\n🔢 UTR: ${utr}\n💳 New Balance: ₹${newBalance}\n⏰ Time: ${new Date().toLocaleString()}`;
    await this.sendNotification(message);
  }
  
async depositRejected(depositData, reason) {
  const { user_id, amount, utr } = depositData;
  const message = `❌ <b>Deposit Rejected</b>\n\n🆔 User ID: <code>${user_id}</code>\n💰 Amount: ₹${amount}\n🔢 UTR: ${utr}\n📝 Reason: ${reason}\n⏰ Time: ${new Date().toLocaleString()}`;
  await this.sendNotification(message);
}

  async giftCodeRedeemed(userId, code, amount, newBalance) {
    const message = `🎟️<b>Gift Code Redeemed</b>\n\n🆔 User ID: <code>${userId}</code>\n🔤 Code: ${code}\n💰 Amount: ₹${amount}\n💳 New Balance: ₹${newBalance}\n⏰ Time: ${new Date().toLocaleString()}`;
    await this.sendNotification(message);
  }
  

  async balanceTransferred(fromUserId, toUserId, amount, note) {
    const message = `🔄 <b>Balance Transfer</b>\n\n👤 From: <code>${fromUserId}</code>\n👤 To: <code>${toUserId}</code>\n💰 Amount: ₹${amount}\n📝 Note: ${note || 'N/A'}\n⏰ Time: ${new Date().toLocaleString()}`;
    await this.sendNotification(message);
  }

  async orderCancelled(orderData, reason) {
    const { user_id, service, phone, price, order_id } = orderData;
    const message = `❌ <b>Order Cancelled</b>\n\n🆔 User ID: <code>${user_id}</code>\n🛍️ Service: ${service}\n📱 Number: <code>${phone}</code>\n💰 Amount: ₹${price}\n🆔 Order ID: ${order_id}\n📝 Reason: ${reason}\n⏰ Time: ${new Date().toLocaleString()}`;
    await this.sendNotification(message);
  }

  async newNumberRequested(orderData, newPhone) {
    const { user_id, service, order_id } = orderData;
    const message = `🆕 <b>New Number Requested</b>\n\n🆔 User ID: <code>${user_id}</code>\n🛍️ Service: ${service}\n📱 New Number: <code>${newPhone}</code>\n🆔 Order ID: ${order_id}\n⏰ Time: ${new Date().toLocaleString()}`;
    await this.sendNotification(message);
  }
}

module.exports = NotificationService;