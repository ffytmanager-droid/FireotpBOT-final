const QRCode = require('qrcode');
const config = require('./config');

class PaymentService {
  generateUPILink(amount, note) {
    const cleanNote = note.replace(/[^A-Za-z0-9x_.]/g, '').replace(/\./g, '_');
    return `upi://pay?pa=${config.UPI_ID}&pn=${encodeURIComponent(config.UPI_NAME)}&am=${amount}&cu=INR&tn=${cleanNote}`;
  }

  generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

  async generateQRCode(upiLink) {
    try {
      const qrBuffer = await QRCode.toBuffer(upiLink, {
        width: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });
      return qrBuffer;
    } catch (error) {
      console.error('QR Code generation error:', error);
      throw new Error('Failed to generate QR code');
    }
  }

  formatCurrency(amount) {
    if (typeof amount !== 'number') return '0.00';
    return amount % 1 === 0 ? amount.toString() : amount.toFixed(2);
  }

  validateUTR(utr) {
    return utr.length >= config.MIN_UTR_LENGTH && /^\d+$/.test(utr);
  }


  validateAmount(amount) {
    return !isNaN(amount) && amount >= config.MIN_DEPOSIT_AMOUNT && amount === Math.floor(amount);
  }

  generateGiftCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  calculateDiscountedPrice(originalPrice, monthlyDeposit) {
    if (!config.DISCOUNT_SETTINGS.enabled) {
      return { finalPrice: originalPrice, discount: 0, discountPercent: 0 };
    }

    const tiers = config.DISCOUNT_SETTINGS.tiers.sort((a, b) => b.deposit - a.deposit);

    for (const tier of tiers) {
      if (monthlyDeposit >= tier.deposit) {
        const discountAmount = (originalPrice * tier.discount) / 100;
        const finalPrice = originalPrice - discountAmount;

        return {
          finalPrice: parseFloat(Math.max(finalPrice, 1).toFixed(2)),
          discount: parseFloat(discountAmount.toFixed(2)),
          discountPercent: tier.discount
        };
      }
    }

    return { finalPrice: originalPrice, discount: 0, discountPercent: 0 };
  }

  getDiscountInfo(monthlyDeposit) {
    if (!config.DISCOUNT_SETTINGS.enabled) {
      return { currentDiscount: 0, nextTier: null, tiers: [] };
    }

    const tiers = config.DISCOUNT_SETTINGS.tiers.sort((a, b) => a.deposit - b.deposit);
    const nextTier = tiers.find(tier => monthlyDeposit < tier.deposit);

    return {
      currentDiscount: this.getCurrentDiscountPercent(monthlyDeposit),
      nextTier: nextTier ? {
        depositNeeded: this.formatCurrency(nextTier.deposit - monthlyDeposit),
        discount: nextTier.discount
      } : null,
      tiers: tiers
    };
  }

  getCurrentDiscountPercent(monthlyDeposit) {
    if (!config.DISCOUNT_SETTINGS.enabled) {
      return 0;
    }

    const tiers = config.DISCOUNT_SETTINGS.tiers.sort((a, b) => b.deposit - a.deposit);

    for (const tier of tiers) {
      if (monthlyDeposit >= tier.deposit) {
        return tier.discount;
      }
    }

    return 0;
  }
}

module.exports = PaymentService;