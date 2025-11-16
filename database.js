// database.js - PostgreSQL Version for Render with DATABASE_URL
const { Client } = require('pg');

class DatabaseManager {
  constructor() {
    this.client = null;
    this.isConnecting = false;
    this.connect();
  }

  async connect() {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      // Use DATABASE_URL from environment variables
      const connectionString = process.env.DATABASE_URL;
      
      if (!connectionString) {
        throw new Error('DATABASE_URL environment variable is required');
      }

      this.client = new Client({
        connectionString: connectionString,
        ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 10000,
        idle_in_transaction_session_timeout: 10000
      });

      await this.client.connect();
      console.log('✅ Connected to PostgreSQL database on Render');
      this.isConnecting = false;
      await this.initDatabase();
    } catch (error) {
      console.error('❌ Database connection error:', error.message);
      this.isConnecting = false;
      // Retry after 5 seconds
      setTimeout(() => this.connect(), 5000);
    }
  }

  getCurrentMonthYear() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  async initDatabase() {
    const queries = [
      `CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY,
        balance DECIMAL(15,2) DEFAULT 0,
        joined_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        channel_joined BOOLEAN DEFAULT FALSE,
        terms_accepted BOOLEAN DEFAULT FALSE,
        last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_orders INTEGER DEFAULT 0,
        first_name TEXT,
        username TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        service TEXT,
        phone TEXT,
        price DECIMAL(10,2),
        order_id TEXT,
        activation_id TEXT,
        status TEXT,
        order_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        otp_code TEXT DEFAULT NULL,
        server_used TEXT,
        original_price DECIMAL(10,2),
        discount_applied DECIMAL(10,2) DEFAULT 0
      )`,

      `CREATE TABLE IF NOT EXISTS active_orders (
        order_id TEXT PRIMARY KEY,
        activation_id TEXT,
        user_id BIGINT,
        phone TEXT,
        product TEXT,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        server_used TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS topup_requests (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        amount DECIMAL(10,2),
        utr TEXT UNIQUE,
        status TEXT,
        request_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS gift_codes (
        code TEXT PRIMARY KEY,
        amount DECIMAL(10,2),
        created_by BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        max_uses INTEGER DEFAULT 1,
        expires_at TIMESTAMP,
        min_deposit DECIMAL(10,2) DEFAULT 0
      )`,

      `CREATE TABLE IF NOT EXISTS gift_code_uses (
        id SERIAL PRIMARY KEY,
        code TEXT,
        user_id BIGINT,
        used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(code, user_id)
      )`,

      `CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_id BIGINT,
        action TEXT,
        target_user_id BIGINT,
        details TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS monthly_deposits (
        user_id BIGINT,
        month_year TEXT,
        total_deposit DECIMAL(15,2) DEFAULT 0,
        PRIMARY KEY (user_id, month_year)
      )`,

      `CREATE TABLE IF NOT EXISTS balance_transfers (
        id SERIAL PRIMARY KEY,
        from_user_id BIGINT,
        to_user_id BIGINT,
        amount DECIMAL(10,2),
        transfer_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        note TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id BIGINT,
        referred_id BIGINT UNIQUE,
        referral_code TEXT,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE
      )`,

      `CREATE TABLE IF NOT EXISTS referral_earnings (
        id SERIAL PRIMARY KEY,
        referrer_id BIGINT,
        referred_id BIGINT,
        deposit_amount DECIMAL(10,2),
        commission_amount DECIMAL(10,2),
        commission_percent DECIMAL(5,2) DEFAULT 5,
        earned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    try {
      console.log('🔄 Creating PostgreSQL tables...');
      for (let i = 0; i < queries.length; i++) {
        await this.client.query(queries[i]);
        console.log(`✅ Table ${i + 1} created successfully`);
      }
      console.log('✅ All PostgreSQL tables created successfully');
    } catch (error) {
      console.error('❌ Error creating tables:', error.message);
    }
  }

  async ensureConnection() {
    try {
      await this.client.query('SELECT 1');
    } catch (error) {
      console.log('🔄 Reconnecting to database...');
      await this.connect();
    }
  }

  async getUser(userId) {
    try {
      await this.ensureConnection();
      const result = await this.client.query(
        'SELECT * FROM users WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        const joinDate = new Date().toISOString();
        await this.client.query(
          `INSERT INTO users (user_id, balance, joined_date, channel_joined, terms_accepted, last_checked, total_orders) 
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [userId, 0, joinDate, false, false, joinDate, 0]
        );
        
        return {
          user_id: userId,
          balance: 0,
          joined_date: joinDate,
          channel_joined: false,
          terms_accepted: false,
          last_checked: joinDate,
          total_orders: 0
        };
      }

      return result.rows[0];
    } catch (error) {
      console.error('Get user error:', error.message);
      throw error;
    }
  }

  async updateUserProfile(userId, firstName, username) {
    await this.ensureConnection();
    await this.client.query(
      'UPDATE users SET first_name = $1, username = $2 WHERE user_id = $3',
      [firstName, username, userId]
    );
  }

  async updateBalance(userId, amount) {
    try {
      await this.ensureConnection();
      console.log(`💰 Updating balance: User ${userId}, Amount: ${amount}`);
      
      const result = await this.client.query(
        'UPDATE users SET balance = balance + $1 WHERE user_id = $2',
        [amount, userId]
      );

      if (result.rowCount === 0) {
        throw new Error('User not found');
      }
    } catch (error) {
      console.error('Update balance error:', error.message);
      throw error;
    }
  }

  async updateMonthlyDeposit(userId, amount) {
    await this.ensureConnection();
    const currentMonth = this.getCurrentMonthYear();
    
    await this.client.query(
      `INSERT INTO monthly_deposits (user_id, month_year, total_deposit) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, month_year) 
       DO UPDATE SET total_deposit = monthly_deposits.total_deposit + $4`,
      [userId, currentMonth, amount, amount]
    );
  }

  async setMonthlyDeposit(userId, amount) {
    await this.ensureConnection();
    const currentMonth = this.getCurrentMonthYear();
    
    await this.client.query(
      `INSERT INTO monthly_deposits (user_id, month_year, total_deposit) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, month_year) 
       DO UPDATE SET total_deposit = $4`,
      [userId, currentMonth, amount, amount]
    );
  }

  async resetMonthlyDeposit(userId) {
    await this.ensureConnection();
    const currentMonth = this.getCurrentMonthYear();
    
    await this.client.query(
      'UPDATE monthly_deposits SET total_deposit = 0 WHERE user_id = $1 AND month_year = $2',
      [userId, currentMonth]
    );
  }

  async getMonthlyDeposit(userId) {
    await this.ensureConnection();
    const currentMonth = this.getCurrentMonthYear();
    
    const result = await this.client.query(
      'SELECT total_deposit FROM monthly_deposits WHERE user_id = $1 AND month_year = $2',
      [userId, currentMonth]
    );
    
    return result.rows[0] ? parseFloat(result.rows[0].total_deposit) : 0;
  }

  async getTopDepositors(limit, offset) {
    await this.ensureConnection();
    const currentMonth = this.getCurrentMonthYear();
    
    const result = await this.client.query(
      `SELECT u.user_id, u.first_name, u.username, md.total_deposit
       FROM monthly_deposits md
       JOIN users u ON u.user_id = md.user_id
       WHERE md.month_year = $1
       ORDER BY md.total_deposit DESC
       LIMIT $2 OFFSET $3`,
      [currentMonth, limit, offset]
    );
    
    const totalResult = await this.client.query(
      'SELECT COUNT(*) as count FROM monthly_deposits WHERE month_year = $1',
      [currentMonth]
    );
    
    return { users: result.rows, total: parseInt(totalResult.rows[0].count) };
  }

  async getAllDepositors(limit, offset) {
    await this.ensureConnection();
    const currentMonth = this.getCurrentMonthYear();
    
    const result = await this.client.query(
      `SELECT u.user_id, u.first_name, u.username, md.total_deposit
       FROM monthly_deposits md
       JOIN users u ON u.user_id = md.user_id
       WHERE md.month_year = $1
       ORDER BY u.user_id
       LIMIT $2 OFFSET $3`,
      [currentMonth, limit, offset]
    );
    
    const totalResult = await this.client.query(
      'SELECT COUNT(*) as count FROM monthly_deposits WHERE month_year = $1',
      [currentMonth]
    );
    
    return { users: result.rows, total: parseInt(totalResult.rows[0].count) };
  }

  async getDiscountedUsers(minDeposit, limit, offset) {
    await this.ensureConnection();
    const currentMonth = this.getCurrentMonthYear();
    
    const result = await this.client.query(
      `SELECT u.user_id, u.first_name, u.username, md.total_deposit
       FROM monthly_deposits md
       JOIN users u ON u.user_id = md.user_id
       WHERE md.month_year = $1 AND md.total_deposit >= $2
       ORDER BY md.total_deposit DESC
       LIMIT $3 OFFSET $4`,
      [currentMonth, minDeposit, limit, offset]
    );
    
    const totalResult = await this.client.query(
      'SELECT COUNT(*) as count FROM monthly_deposits WHERE month_year = $1 AND total_deposit >= $2',
      [currentMonth, minDeposit]
    );
    
    return { users: result.rows, total: parseInt(totalResult.rows[0].count) };
  }

  async incrementOrderCount(userId) {
    await this.ensureConnection();
    await this.client.query(
      'UPDATE users SET total_orders = total_orders + 1 WHERE user_id = $1',
      [userId]
    );
  }

  async getTotalUsers() {
    await this.ensureConnection();
    const result = await this.client.query('SELECT COUNT(*) as count FROM users');
    return parseInt(result.rows[0].count);
  }

  async getTotalOrders() {
    await this.ensureConnection();
    const result = await this.client.query('SELECT COUNT(*) as count FROM orders');
    return parseInt(result.rows[0].count);
  }

  async getTotalRevenue() {
    await this.ensureConnection();
    const result = await this.client.query(
      'SELECT SUM(price) as total FROM orders WHERE status = $1',
      ['completed']
    );
    return result.rows[0].total ? parseFloat(result.rows[0].total) : 0;
  }

  async getAllUsers(limit = 50) {
    await this.ensureConnection();
    const result = await this.client.query(
      'SELECT user_id, first_name, username, balance, total_orders, joined_date FROM users ORDER BY joined_date DESC LIMIT $1',
      [limit]
    );
    return result.rows;
  }

  async searchUsers(query) {
    await this.ensureConnection();
    const searchQuery = `%${query}%`;
    const result = await this.client.query(
      `SELECT user_id, first_name, username, balance, total_orders
       FROM users
       WHERE user_id::text LIKE $1 OR first_name LIKE $2 OR username LIKE $3
       LIMIT 20`,
      [searchQuery, searchQuery, searchQuery]
    );
    return result.rows;
  }

  async createGiftCode(codeData) {
    await this.ensureConnection();
    const { code, amount, createdBy, maxUses = 1, expiresAt } = codeData;
    
    const result = await this.client.query(
      'INSERT INTO gift_codes (code, amount, created_by, max_uses, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [code, amount, createdBy, maxUses, expiresAt]
    );
    
    return result.rows[0];
  }

  async getGiftCode(code) {
    await this.ensureConnection();
    const result = await this.client.query(
      `SELECT g.*, COUNT(gu.id) as used_count
       FROM gift_codes g
       LEFT JOIN gift_code_uses gu ON g.code = gu.code
       WHERE g.code = $1
       GROUP BY g.code`,
      [code]
    );
    
    return result.rows[0] || null;
  }

  async checkIfUserUsedGiftCode(code, userId) {
    await this.ensureConnection();
    const result = await this.client.query(
      'SELECT id FROM gift_code_uses WHERE code = $1 AND user_id = $2',
      [code, userId]
    );
    
    return result.rows.length > 0;
  }

  async checkUserDepositCondition(userId, minDeposit = 0) {
    try {
      await this.ensureConnection();
      const monthlyDeposit = await this.getMonthlyDeposit(userId);
      return monthlyDeposit >= minDeposit;
    } catch (error) {
      console.error('Deposit condition check error:', error.message);
      return false;
    }
  }

  async createGiftCodeWithCondition(codeData) {
    await this.ensureConnection();
    const { code, amount, createdBy, maxUses = 1, expiresAt, minDeposit = 0 } = codeData;
    
    const result = await this.client.query(
      'INSERT INTO gift_codes (code, amount, created_by, max_uses, expires_at, min_deposit) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [code, amount, createdBy, maxUses, expiresAt, minDeposit]
    );
    
    return result.rows[0];
  }

  async getGiftCodeWithCondition(code) {
    return this.getGiftCode(code);
  }

  async getAllGiftCodes() {
    await this.ensureConnection();
    const result = await this.client.query('SELECT * FROM gift_codes ORDER BY created_at DESC');
    return result.rows;
  }

  async deleteGiftCode(code) {
    await this.ensureConnection();
    const result = await this.client.query('DELETE FROM gift_codes WHERE code = $1', [code]);
    return result.rowCount > 0;
  }

  async useGiftCode(code, userId) {
    try {
      await this.ensureConnection();
      const giftCode = await this.getGiftCode(code);
      
      if (!giftCode) {
        return false;
      }

      if (giftCode.expires_at && new Date(giftCode.expires_at) < new Date()) {
        return false;
      }

      if (giftCode.max_uses > 0 && giftCode.used_count >= giftCode.max_uses) {
        return false;
      }

      const alreadyUsed = await this.checkIfUserUsedGiftCode(code, userId);
      if (alreadyUsed) {
        return false;
      }

      await this.client.query(
        'INSERT INTO gift_code_uses (code, user_id) VALUES ($1, $2)',
        [code, userId]
      );
      
      return true;
    } catch (error) {
      console.error('Gift code processing error:', error.message);
      return false;
    }
  }

  async transferBalance(fromUserId, toUserId, amount, note = '') {
    try {
      await this.ensureConnection();
      await this.client.query('BEGIN');
      
      await this.updateBalance(fromUserId, -amount);
      await this.updateBalance(toUserId, amount);

      const result = await this.client.query(
        'INSERT INTO balance_transfers (from_user_id, to_user_id, amount, note) VALUES ($1, $2, $3, $4) RETURNING id',
        [fromUserId, toUserId, amount, note]
      );
      
      await this.client.query('COMMIT');
      return result.rows[0].id;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }

  async getBalanceTransfers(userId) {
    await this.ensureConnection();
    const result = await this.client.query(
      `SELECT * FROM balance_transfers
       WHERE from_user_id = $1 OR to_user_id = $1
       ORDER BY transfer_time DESC
       LIMIT 20`,
      [userId]
    );
    
    return result.rows;
  }

  async getTotalBalanceTransfers() {
    await this.ensureConnection();
    const result = await this.client.query('SELECT COUNT(*) as count FROM balance_transfers');
    return parseInt(result.rows[0].count);
  }

  async setChannelJoined(userId) {
    await this.ensureConnection();
    const now = new Date().toISOString();
    await this.client.query(
      'UPDATE users SET channel_joined = true, last_checked = $1 WHERE user_id = $2',
      [now, userId]
    );
  }

  async setChannelLeft(userId) {
    await this.ensureConnection();
    await this.client.query(
      'UPDATE users SET channel_joined = false WHERE user_id = $1',
      [userId]
    );
  }

  async setTermsAccepted(userId) {
    await this.ensureConnection();
    await this.client.query(
      'UPDATE users SET terms_accepted = true WHERE user_id = $1',
      [userId]
    );
  }

  async updateLastChecked(userId) {
    await this.ensureConnection();
    const now = new Date().toISOString();
    await this.client.query(
      'UPDATE users SET last_checked = $1 WHERE user_id = $2',
      [now, userId]
    );
  }

  async getUsersForVerification() {
    await this.ensureConnection();
    const result = await this.client.query('SELECT user_id FROM users WHERE channel_joined = true');
    return result.rows.map(row => row.user_id);
  }

  async addOrder(orderData) {
    await this.ensureConnection();
    const { user_id, service, phone, price, order_id, activation_id, status, server_used, original_price, discount_applied } = orderData;

    const result = await this.client.query(
      `INSERT INTO orders (user_id, service, phone, price, order_id, activation_id, status, server_used, original_price, discount_applied)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [user_id, service, phone, price, order_id, activation_id, status, server_used || '', original_price || price, discount_applied || 0]
    );

    await this.incrementOrderCount(user_id);
    return result.rows[0].id;
  }

  async addActiveOrder(orderData) {
    await this.ensureConnection();
    const { order_id, activation_id, user_id, phone, product, expires_at, server_used } = orderData;
    
    await this.client.query(
      `INSERT INTO active_orders (order_id, activation_id, user_id, phone, product, expires_at, server_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (order_id) 
       DO UPDATE SET activation_id = $2, phone = $4, expires_at = $6, server_used = $7`,
      [order_id, activation_id, user_id, phone, product, expires_at, server_used || '']
    );
  }

  async removeActiveOrder(orderId) {
    await this.ensureConnection();
    await this.client.query('DELETE FROM active_orders WHERE order_id = $1', [orderId]);
  }

  async getActiveOrders(userId) {
    await this.ensureConnection();
    const result = await this.client.query('SELECT * FROM active_orders WHERE user_id = $1', [userId]);
    return result.rows;
  }

  async getUserOrders(userId) {
    await this.ensureConnection();
    const result = await this.client.query(
      `SELECT order_id, service, phone, price, status, order_time, otp_code, server_used, original_price, discount_applied
       FROM orders WHERE user_id = $1 ORDER BY order_time DESC LIMIT 10`,
      [userId]
    );
    return result.rows;
  }

  async updateOrderOTP(orderId, otpCode) {
    await this.ensureConnection();
    await this.client.query(
      'UPDATE orders SET otp_code = $1, status = $2 WHERE order_id = $3',
      [otpCode, 'completed', orderId]
    );
  }

  async cancelOrder(orderId) {
    await this.ensureConnection();
    await this.client.query(
      'UPDATE orders SET status = $1 WHERE order_id = $2',
      ['cancelled', orderId]
    );
  }

  async logTopupRequest(userId, amount, utr, status) {
    await this.ensureConnection();
    const result = await this.client.query(
      `INSERT INTO topup_requests (user_id, amount, utr, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, amount, utr, status]
    );
    
    return result.rows[0].id;
  }

  async updateTopupStatus(requestId, status) {
    await this.ensureConnection();
    await this.client.query(
      'UPDATE topup_requests SET status = $1 WHERE id = $2',
      [status, requestId]
    );
  }

  async getTopupRequestInfo(requestId) {
    await this.ensureConnection();
    const result = await this.client.query(
      'SELECT user_id, amount, utr, status FROM topup_requests WHERE id = $1',
      [requestId]
    );
    
    return result.rows[0] || null;
  }

  async checkDuplicateUTR(utr) {
    await this.ensureConnection();
    const result = await this.client.query('SELECT id FROM topup_requests WHERE utr = $1', [utr]);
    return result.rows.length > 0;
  }

  async getUserDepositHistory(userId) {
    await this.ensureConnection();
    const result = await this.client.query(
      `SELECT id, amount, utr, status, request_time
       FROM topup_requests WHERE user_id = $1 ORDER BY request_time DESC LIMIT 10`,
      [userId]
    );
    
    return result.rows;
  }

  async createReferral(referrerId, referredId, referralCode) {
    await this.ensureConnection();
    const result = await this.client.query(
      `INSERT INTO referrals (referrer_id, referred_id, referral_code) 
       VALUES ($1, $2, $3)
       ON CONFLICT (referred_id) 
       DO UPDATE SET referrer_id = $1, referral_code = $3, joined_at = CURRENT_TIMESTAMP, is_active = true
       RETURNING id`,
      [referrerId, referredId, referralCode]
    );
    
    return result.rows[0].id;
  }

  async getReferralByCode(referralCode) {
    await this.ensureConnection();
    const result = await this.client.query(
      'SELECT * FROM referrals WHERE referral_code = $1 AND is_active = true',
      [referralCode]
    );
    
    return result.rows[0] || null;
  }

  async getReferralByReferredId(referredId) {
    await this.ensureConnection();
    const result = await this.client.query(
      'SELECT * FROM referrals WHERE referred_id = $1',
      [referredId]
    );
    
    return result.rows[0] || null;
  }

  async getReferralCodeByUserId(userId) {
    await this.ensureConnection();
    const result = await this.client.query(
      'SELECT referral_code FROM referrals WHERE referrer_id = $1 AND referred_id = $1',
      [userId]
    );
    
    return result.rows[0] ? result.rows[0].referral_code : null;
  }

  async getUserReferrals(userId) {
    await this.ensureConnection();
    const result = await this.client.query(
      `SELECT r.*, u.first_name, u.username 
       FROM referrals r 
       JOIN users u ON r.referred_id = u.user_id 
       WHERE r.referrer_id = $1 AND r.is_active = true 
       ORDER BY r.joined_at DESC`,
      [userId]
    );
    
    return result.rows;
  }

  async addReferralEarning(earningData) {
    await this.ensureConnection();
    const { referrer_id, referred_id, deposit_amount, commission_amount, commission_percent = 5 } = earningData;

    console.log(`💾 Saving referral earning: Referrer ${referrer_id}, Referred ${referred_id}, Commission ₹${commission_amount}`);

    const result = await this.client.query(
      `INSERT INTO referral_earnings 
       (referrer_id, referred_id, deposit_amount, commission_amount, commission_percent) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [referrer_id, referred_id, deposit_amount, commission_amount, commission_percent]
    );
    
    console.log(`✅ Referral earning saved with ID: ${result.rows[0].id}`);
    return result.rows[0].id;
  }

  async getReferralEarnings(userId) {
    await this.ensureConnection();
    const result = await this.client.query(
      `SELECT re.*, u.first_name, u.username 
       FROM referral_earnings re 
       JOIN users u ON re.referred_id = u.user_id 
       WHERE re.referrer_id = $1 
       ORDER BY re.earned_at DESC`,
      [userId]
    );
    
    return result.rows;
  }

  async getTotalReferralEarnings(userId) {
    await this.ensureConnection();
    const result = await this.client.query(
      'SELECT SUM(commission_amount) as total_earnings FROM referral_earnings WHERE referrer_id = $1',
      [userId]
    );
    
    return result.rows[0]?.total_earnings ? parseFloat(result.rows[0].total_earnings) : 0;
  }

  async getReferralStats(userId) {
    await this.ensureConnection();
    const result = await this.client.query(
      `SELECT 
        COUNT(*) as total_referrals,
        COUNT(CASE WHEN re.commission_amount IS NOT NULL THEN 1 END) as active_referrals,
        COALESCE(SUM(re.commission_amount), 0) as total_earnings
       FROM referrals r
       LEFT JOIN referral_earnings re ON r.referred_id = re.referred_id
       WHERE r.referrer_id = $1 AND r.is_active = true`,
      [userId]
    );
    
    return result.rows[0] || { total_referrals: 0, active_referrals: 0, total_earnings: 0 };
  }

  async debugAllReferrals() {
    await this.ensureConnection();
    const result = await this.client.query('SELECT * FROM referrals');
    console.log('🔍 DEBUG - All referrals:', result.rows);
    return result.rows;
  }

  async close() {
    if (this.client) {
      await this.client.end();
    }
  }
}

module.exports = DatabaseManager;
