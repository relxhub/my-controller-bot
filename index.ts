// index.ts

// 1. นำเข้าเครื่องมือที่ต้องใช้
import { Telegraf, Markup } from 'telegraf';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

// โหลดค่าจากไฟล์ .env (พวก Token และ Database URL)
dotenv.config();

// 2. เริ่มต้นระบบ
// ตรวจสอบว่ามี Token หรือไม่ ถ้าไม่มีให้แจ้งเตือน
if (!process.env.BOT_TOKEN) {
  throw new Error('กรุณาใส่ BOT_TOKEN ในไฟล์ .env');
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const prisma = new PrismaClient();

// --- ฟังก์ชันตัวช่วย (Helper) ---

// ฟังก์ชันสำหรับหา User ใน Database ถ้าไม่มีให้สร้างใหม่
// นี่คือสิ่งที่ทำให้บอท "จำ" คนใช้งานได้
async function getOrCreateUser(telegramId: number, username: string | undefined) {
  // แปลง telegramId เป็น BigInt เพราะ Prisma ใช้ BigInt กับเลขเยอะๆ
  const id = BigInt(telegramId);
  
  let user = await prisma.user.findUnique({ 
    where: { telegramId: id } 
  });

  if (!user) {
    user = await prisma.user.create({
      data: { telegramId: id, username: username || '' }
    });
  }
  return user;
}

// --- ส่วนคำสั่งหลัก (Commands) ---

// 1. เมื่อ User พิมพ์ /start
bot.start(async (ctx) => {
  await getOrCreateUser(ctx.from.id, ctx.from.username);
  ctx.reply(
    '👋 สวัสดีครับ! ผมคือบอทเลียนแบบ ControllerBot\n\n' +
    'พิมพ์ /createpost เพื่อเริ่มสร้างโพสต์ใหม่ครับ'
  );
});

// 2. เมื่อ User พิมพ์ /createpost
bot.command('createpost', async (ctx) => {
  const userId = ctx.from.id;
  
  // อัปเดตสถานะ User ให้เป็น "รอรับเนื้อหา" (WAITING_CONTENT)
  // และล้างค่า Draft เก่าทิ้ง
  await prisma.user.update({
    where: { telegramId: BigInt(userId) },
    data: { state: 'WAITING_CONTENT', draft: '' }
  });

  ctx.reply('📝 กรุณาส่ง **ข้อความ** หรือ **รูปภาพ** ที่ต้องการโพสต์ครับ', { parse_mode: 'Markdown' });
});

// --- ส่วนจัดการข้อความ (Text Logic) ---
// บอทจะเข้ามาทำงานตรงนี้ทุกครั้งที่ User พิมพ์ข้อความอะไรก็ตามมา
bot.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const user = await getOrCreateUser(telegramId, ctx.from.username);
  const text = ctx.message.text;

  // CASE A: บอทกำลังรอเนื้อหาโพสต์
  if (user.state === 'WAITING_CONTENT') {
    // บันทึกข้อความลง Draft และเปลี่ยนสถานะเป็น "รอรับปุ่ม"
    await prisma.user.update({
      where: { telegramId: BigInt(telegramId) },
      data: { 
        draft: text, 
        state: 'WAITING_BUTTONS' 
      }
    });

    // แจ้ง User และสอนวิธีใส่ปุ่ม
    await ctx.reply(
      '✅ บันทึกเนื้อหาแล้ว!\n\n' +
      'ต่อไปส่ง **ปุ่ม (Inline Buttons)** ในรูปแบบนี้:\n\n' +
      'Google - https://google.com\n' +
      'Facebook - https://facebook.com\n\n' +
      '(พิมพ์คำว่า "skip" ถ้าไม่ต้องการปุ่ม)'
    );
  } 
  
  // CASE B: บอทกำลังรอรับปุ่ม URL
  else if (user.state === 'WAITING_BUTTONS') {
    let inlineKeyboard: any[] = [];
    
    // ถ้า User ไม่ได้พิมพ์ว่า skip ให้พยายามสร้างปุ่ม
    if (text.toLowerCase() !== 'skip') {
      const lines = text.split('\n'); // แยกทีละบรรทัด
      
      // วนลูปสร้างปุ่มทีละบรรทัด
      const buttons = lines.map(line => {
        // แยกข้อความกับลิงก์ ด้วยเครื่องหมาย " - "
        const parts = line.split(' - '); 
        if (parts.length >= 2) {
            // สร้างปุ่ม URL
            // parts[0] คือชื่อปุ่ม, parts[1] คือลิงก์
            return Markup.button.url(parts[0].trim(), parts[1].trim());
        }
        return null;
      }).filter(b => b !== null); // กรองอันที่สร้างไม่ได้ทิ้งไป

      if (buttons.length > 0) {
        // จัดให้ปุ่มเรียงเป็นแนวตั้ง (1 ปุ่มต่อ 1 แถว)
        buttons.forEach(btn => inlineKeyboard.push([btn]));
      }
    }

    // เพิ่มปุ่มเมนู "ยืนยัน" และ "ยกเลิก" ต่อท้าย
    inlineKeyboard.push([
        Markup.button.callback('✅ โพสต์เลย (Confirm)', 'BTN_CONFIRM'),
        Markup.button.callback('❌ ยกเลิก (Cancel)', 'BTN_CANCEL')
    ]);

    // สร้าง Keyboard Object
    const keyboardMarkup = Markup.inlineKeyboard(inlineKeyboard);

    // ส่งตัวอย่าง (Preview) กลับไปให้ User ดู
    await ctx.replyWithMarkdown(
      `*ตัวอย่างโพสต์ของคุณ:*\n\n${user.draft}`, 
      keyboardMarkup
    );
    
    // เปลี่ยนสถานะเป็น IDLE (จบกระบวนการสร้าง รอการกดปุ่ม)
    await prisma.user.update({
        where: { telegramId: BigInt(telegramId) },
        data: { state: 'IDLE' } 
    });
  }
});

// --- ส่วนจัดการการกดปุ่ม (Action Logic) ---

// เมื่อกดปุ่ม "โพสต์เลย"
bot.action('BTN_CONFIRM', async (ctx) => {
  if (!ctx.from) return;  
  // แจ้งเตือนว่ารับทราบแล้ว
  await ctx.answerCbQuery('กำลังโพสต์...');
  
  // ดึงข้อมูล User มาเช็ค Draft อีกที
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
  
  if (user && user.draft) {
    // *** ของจริง: ตรงนี้คุณเปลี่ยนเป็น chat_id ของ Channel ที่ต้องการได้ ***
    // เช่น: await ctx.telegram.sendMessage('@my_channel_name', user.draft, ...);
    
    // ในตัวอย่าง: ส่งกลับเข้าห้องเดิม
    await ctx.reply('🚀 โพสต์ลง Channel เรียบร้อย! (สมมุตินะ)');
    
    // (Optional) ล้าง Draft ทิ้ง
    await prisma.user.update({
        where: { telegramId: BigInt(ctx.from!.id) },
        data: { draft: '' }
    });
  }
});

// เมื่อกดปุ่ม "ยกเลิก"
bot.action('BTN_CANCEL', async (ctx) => {
  if (!ctx.from) return;  
  await ctx.answerCbQuery('ยกเลิกแล้ว');
  await ctx.reply('❌ ยกเลิกการสร้างโพสต์เรียบร้อย');
  // ไม่ต้องทำอะไรกับ DB เพราะ State เป็น IDLE อยู่แล้ว
});

// 3. เริ่มรันบอท
bot.launch().then(() => {
    console.log('🤖 Bot is running...');
});

// จัดการการปิดบอทให้ปลอดภัย (Graceful Stop)
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));