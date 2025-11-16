const axios = require('axios');
const config = require('./config');

class FirexOTPService {
  constructor() {
    this.apiKey = config.FIREX_API_KEY;
    this.baseURL = config.FIREX_BASE_URL;
    this.timeout = 15000;
  }

  async makeRequest(params) {
    try {
      console.log('FirexOTP API Request:', params);

      const response = await axios({
        method: 'GET',
        url: this.baseURL,
        params: {
          api_key: this.apiKey,
          ...params
        },
        timeout: this.timeout
      });

      console.log(' FirexOTP API Response:', response.data);

      return response.data;
    } catch (error) {
      console.error('FirexOTP API Error:', error.message);

      if (error.code === 'ECONNABORTED') {
        throw new Error('❌ Request timeout');
      } else if (error.response?.status === 401) {
        throw new Error('❌ Invalid API Key');
      } else {
        throw new Error('❌ Service temporarily unavailable');
      }
    }
  }

async buyNumber(service, country) {
  try {
    const data = await this.makeRequest({
      action: 'getNumber',
      service: service,
      country: country
    });

    console.log('Raw API Response for buyNumber:', data);
    
    if (typeof data === 'string') {
      if (data.startsWith('ACCESS_NUMBER')) {
        const parts = data.split(':');
        if (parts.length >= 3) {
          let phoneNumber = parts[2];
          const orderId = parts[1];
          
          phoneNumber = phoneNumber.replace('+91', '').replace('91', '');
          
          if (phoneNumber.length === 10 && /^\d+$/.test(phoneNumber)) {
            return {
              success: true,
              number: phoneNumber,
              orderId: orderId
            };
          } else {
            return {
              success: false,
              error: `❌ Invalid phone number format: ${phoneNumber}`
            };
          }
        }
      } 
   
      else if (data.startsWith('ACCESS_')) {
        const parts = data.split(':');
        if (parts.length >= 3) {
          return {
            success: true,
            number: parts[2].replace('+91', '').replace('91', ''),
            orderId: parts[1]
          };
        }
      }
      else if (data === 'NO_NUMBERS') {
        return { success: false, error: '❌ No numbers available for this service' };
      } else if (data === 'NO_BALANCE') {
        return { success: false, error: '❌ Insufficient API balance' };
      } else if (data.startsWith('ERROR')) {
        return { success: false, error: `❌ API Error: ${data}` };
      }
    }

    return { success: false, error: `❌ Unknown API response: ${data}` };
  } catch (error) {
    console.error('Buy Number Error:', error);
    return { success: false, error: error.message };
  }
}

  async checkOrder(orderId) {
    try {
      const data = await this.makeRequest({
        action: 'getStatus',
        id: orderId
      });

      console.log('Raw API Response for checkOrder:', data);
      if (typeof data === 'string') {
        if (data.startsWith('STATUS_WAIT_CODE')) {
          return { status: 'WAITING', code: null };
        } else if (data.startsWith('STATUS_OK')) {
          const parts = data.split(':');
          if (parts.length >= 2) {
            return { status: 'SUCCESS', code: parts[1] };
          } else {
            return { status: 'SUCCESS', code: null };
          }
        } else if (data.startsWith('STATUS_CANCEL')) {
          return { status: 'CANCELLED', code: null };
        } else if (data === 'NO_ACTIVATION') {
          return { status: 'NOT_FOUND', code: null };
        } else if (data.startsWith('ERROR')) {
          return { status: 'ERROR', code: null, error: data };
        } else {
          console.log('Unknown status response:', data);
          return { status: 'UNKNOWN', code: null, raw: data };
        }
      }

      return { status: 'ERROR', code: null };
    } catch (error) {
      console.error('Check order error:', error.message);
      return { status: 'ERROR', code: null };
    }
  }

  async cancelOrder(orderId) {
  try {
    console.log(`🔄 Attempting to cancel order: ${orderId}`);
    
    const data = await this.makeRequest({
      action: 'setStatus',
      id: orderId,
      status: '8'
    });
    
    console.log('📋 Cancel Order Response:', data);
    
    if (data === 'ACCESS_CANCEL' || data === 'ACCESS_READY' || data.includes('CANCEL')) {
      console.log(`✅ Order ${orderId} cancelled successfully`);
      return true;
    } else if (data === 'NO_ACTIVATION' || data.includes('NO_ACTIVATION')) {
      console.log(`❌ Order ${orderId} not found or already cancelled`);
      return false;
    } else {
      console.log(`❌ Unexpected cancel response: ${data}`);
      return false;
    }
  } catch (error) {
    console.error('❌ Cancel order error:', error.message);
    return false;
  }
}

  async requestNewNumber(orderId) {
    try {
      console.log(`Requesting new number for order: ${orderId}`);
      
      const data = await this.makeRequest({
        action: 'setStatus',
        id: orderId,
        status: '3'
      });

      console.log('New Number Response:', data);
      if (data === 'ACCESS_RETRY_GET') {
        console.log(`✅ New number requested successfully for order ${orderId}`);
        return true;
      } else if (data === 'NO_ACTIVATION') {
        console.log(`❌ Order ${orderId} not found`);
        return false;
      } else if (data.startsWith('ERROR')) {
        console.log(`❌ Error requesting new number: ${data}`);
        return false;
      } else {
        console.log(`❌ Unexpected new number response: ${data}`);
        return false;
      }
    } catch (error) {
      console.error('New number request error:', error.message);
      return false;
    }
  }
  async forceCancelExpiredOrder(orderId) {
    try {
      console.log(`🕒 Force cancelling expired order: ${orderId}`);
      
      const result = await this.cancelOrder(orderId);
      
      if (result) {
        console.log(`✅ Successfully force cancelled expired order: ${orderId}`);
      } else {
        console.log(`❌ Failed to force cancel expired order: ${orderId}`);
      }
      
      return result;
    } catch (error) {
      console.error(`Force cancel error for order ${orderId}:`, error.message);
      return false;
    }
  }
}

module.exports = FirexOTPService;