require('dotenv').config();

const validateEnv = () => {
  const required = [
    'BOT_TOKEN',
    'NOTIFICATION_BOT_TOKEN', 
    'NOTIFICATION_CHAT_ID',
    'FIREX_API_KEY',
    'FIREX_BASE_URL',
    'CHANNEL_ID',
    'CHANNEL_LINK',
    'UPI_ID',
    'UPI_NAME',
    'ADMIN_ID',
    'MIN_UTR_LENGTH',
    'FIRE_OTP_NOTE_PREFIX',
    'MIN_DEPOSIT_AMOUNT'
  ];

  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('Missing required environment variables:', missing);
    console.log('Please check your .env file');
    process.exit(1);
  }
};

validateEnv();

module.exports = {

  BOT_TOKEN: process.env.BOT_TOKEN,
  NOTIFICATION_BOT_TOKEN: process.env.NOTIFICATION_BOT_TOKEN,
  NOTIFICATION_CHAT_ID: process.env.NOTIFICATION_CHAT_ID,

  FIREX_API_KEY: process.env.FIREX_API_KEY,
  FIREX_BASE_URL: process.env.FIREX_BASE_URL,

  CHANNEL_ID: process.env.CHANNEL_ID,
  CHANNEL_LINK: process.env.CHANNEL_LINK,

 
  UPI_ID: process.env.UPI_ID,
  UPI_NAME: process.env.UPI_NAME,
  ADMIN_ID: parseInt(process.env.ADMIN_ID) || 0,
  MIN_UTR_LENGTH: parseInt(process.env.MIN_UTR_LENGTH) || 10,
  FIRE_OTP_NOTE_PREFIX: process.env.FIRE_OTP_NOTE_PREFIX || 'FIRE',
  MIN_DEPOSIT_AMOUNT: parseInt(process.env.MIN_DEPOSIT_AMOUNT) || 100,

  DISCOUNT_SETTINGS: {
    enabled: true,
    tiers: [
      { deposit: 5000, discount: 2 },
      { deposit: 10000, discount: 5 },
      { deposit: 20000, discount: 10 }
    ]
  },

  REFERRAL_SETTINGS: {
    enabled: true,
    commission_percent: 5,
    min_deposit_for_commission: 1,
    referral_code_length: 8
  },

  BROADCAST_SETTINGS: {
  enabled: true,
  max_message_length: 4096,
  allowed_formats: ['text', 'photo', 'document']
},

  SERVICES: {
    "SHEIN": { name: "SHEIN", price: 8.44, command: "/find_SHEIN" },
    "FACEBOOK": { name: "Facebook", price: 18, command: "/find_FACEBOOK" },
    "WHATSAPP": { name: "Whatsapp", price: 20, command: "/find_WHATSAPP" },
    "TELEGRAM": { name: "Telegram", price: 22, command: "/find_TELEGRAM" },
    "INSTAGRAM": { name: "Instagram", price: 16, command: "/find_INSTAGRAM" },
    "SPOTIFY": { name: "Spotify", price: 12, command: "/find_SPOTIFY" },
    "LOVERUMMY": { name: "LOVERUMMY", price: 17, command: "/find_LOVERUMMY" },
    "MYNTRA": { name: "MYNTRA", price: 17, command: "/find_MYNTRA" },
    "AMAZON": { name: "Amazon", price: 25, command: "/find_AMAZON" },
    "GOOGLE": { name: "Google", price: 20, command: "/find_GOOGLE" },
    "NETFLIX": { name: "Netflix", price: 30, command: "/find_NETFLIX" },
    "PAYTM": { name: "Paytm", price: 15, command: "/find_PAYTM" },
    "PHONEPE": { name: "PhonePe", price: 15, command: "/find_PHONEPE" },
    "GPAY": { name: "GPay", price: 15, command: "/find_GPAY" },
    "SWIGGY": { name: "Swiggy", price: 12, command: "/find_SWIGGY" },
    "ZOMATO": { name: "Zomato", price: 12, command: "/find_ZOMATO" },
    "OLA": { name: "Ola", price: 18, command: "/find_OLA" },
    "UBER": { name: "Uber", price: 18, command: "/find_UBER" },
    "FLIPKART": { name: "Flipkart", price: 20, command: "/find_FLIPKART" },
    "AJIO": { name: "Ajio", price: 16, command: "/find_AJIO" },
    "NYKAA": { name: "Nykaa", price: 16, command: "/find_NYKAA" },
    "BIGBASKET": { name: "BigBasket", price: 14, command: "/find_BIGBASKET" },
    "GROFERS": { name: "Grofers", price: 14, command: "/find_GROFERS" },
    "DOMINOS": { name: "Dominos", price: 12, command: "/find_DOMINOS" },
    "PIZZAHUT": { name: "PizzaHut", price: 12, command: "/find_PIZZAHUT" },
    "BOOKMYSHOW": { name: "BookMyShow", price: 15, command: "/find_BOOKMYSHOW" },
    "HOTSTAR": { name: "Hotstar", price: 18, command: "/find_HOTSTAR" },
    "PRIME": { name: "Amazon Prime", price: 25, command: "/find_PRIME" },
    "YOUTUBE": { name: "YouTube", price: 22, command: "/find_YOUTUBE" },
    "TWITTER": { name: "Twitter", price: 20, command: "/find_TWITTER" },
    "DISCORD": { name: "Discord", price: 18, command: "/find_DISCORD" },
    "SNAPCHAT": { name: "Snapchat", price: 16, command: "/find_SNAPCHAT" },
    "LINKEDIN": { name: "LinkedIn", price: 20, command: "/find_LINKEDIN" },
    "MICROSOFT": { name: "Microsoft", price: 22, command: "/find_MICROSOFT" },
    "APPLE": { name: "Apple", price: 25, command: "/find_APPLE" },
    "CRED": { name: "CRED", price: 18, command: "/find_CRED" },
    "BYJUS": { name: "BYJUS", price: 16, command: "/find_BYJUS" },
    "UNACADEMY": { name: "Unacademy", price: 16, command: "/find_UNACADEMY" },
    "OLAELECTRIC": { name: "Ola Electric", price: 20, command: "/find_OLAELECTRIC" },
    "RAPIDO": { name: "Rapido", price: 15, command: "/find_RAPIDO" },
    "ZEPTO": { name: "Zepto", price: 12, command: "/find_ZEPTO" },
    "BLINKIT": { name: "Blinkit", price: 12, command: "/find_BLINKIT" },
    "MPHASIS": { name: "Mphasis", price: 18, command: "/find_MPHASIS" },
    "TCS": { name: "TCS", price: 20, command: "/find_TCS" },
    "INFOSYS": { name: "Infosys", price: 20, command: "/find_INFOSYS" },
    "WIPRO": { name: "Wipro", price: 18, command: "/find_WIPRO" },
    "HCL": { name: "HCL", price: 18, command: "/find_HCL" }
  },

  SERVICE_SERVERS: {
    "SHEIN": [
      {
        name: "Server 1",
        success: "98%",
        price: 8.44,
        time: "10-15 sec",
        country: "58",
        service: "shein"
      },
      {
        name: "Server 2",
        success: "95%",
        price: 9,
        time: "15-20 sec",
        country: "58",
        service: "shein"
      }
    ],
    "FACEBOOK": [
      {
        name: "SERVER 1",
        success: "99%",
        price: 18,
        time: "5-10 sec",
        country: "58",
        service: "fb"
      }
    ],
    "WHATSAPP": [
      {
        name: "SERVER 1",
        success: "99%",
        price: 20,
        time: "5-10 sec",
        country: "58",
        service: "wa"
      }
    ],
    "DEFAULT": [
      {
        name: "SERVER DEFAULT",
        success: "95%",
        price: 15,
        time: "10-15 sec",
        country: "58",
        service: "any"
      }
    ]
  }
};