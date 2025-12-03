import { Telegraf, Markup } from 'telegraf';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config();

if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN is missing');

const bot = new Telegraf(process.env.BOT_TOKEN);
const prisma = new PrismaClient();

// --- Helper Functions ---
async function getOrCreateUser(ctx: any) {
  const telegramId = BigInt(ctx.from.id);
  let user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) {
    user = await prisma.user.create({
      data: { telegramId, username: ctx.from.username || '' }
    });
  }
  return user;
}

// เมนูหลัก (Main Menu)
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📝 สร้างโพสต์ใหม่ (Create Post)', 'MENU_CREATE')],
  [Markup.button.callback('📢 จัดการแชนแนล (Channels)', 'MENU_CHANNELS')],
  [Markup.button.callback('❓ วิธีใช้งาน', 'MENU_HELP')]
]);

// --- 1. เริ่มต้นใช้งาน ---
bot.start(async (ctx) => {
  await getOrCreateUser(ctx);
  // Reset State กลับเป็น IDLE
  await prisma.user.update({
    where: { telegramId: BigInt(ctx.from.id) },
    data: { state: 'IDLE', draft: '', selectedChannelId: null }
  });
  
  await ctx.reply(
    '👋 สวัสดีครับ! ยินดีต้อนรับสู่บอทจัดการโพสต์\nเลือกเมนูด้านล่างได้เลยครับ:',
    mainMenu
  );
});

// --- 2. จัดการแชนแนล (Add Channel Logic) ---
bot.action('MENU_CHANNELS', async (ctx) => {
    if (!ctx.from) return;
    const user = await getOrCreateUser(ctx);
    
    // ดึงรายชื่อ Channel ของ User คนนี้
    const channels = await prisma.channel.findMany({
        where: { addedById: user.id }
    });

    let msg = '📢 **รายชื่อแชนแนลของคุณ:**\n\n';
    if (channels.length === 0) {
        msg += '❌ ยังไม่มีแชนแนลที่บันทึกไว้';
    } else {
        channels.forEach(ch => {
            msg += `✅ ${ch.title}\n`;
        });
    }

    msg += '\n\n**วิธีเพิ่มแชนแนล:**\n1. ดึงบอทเข้า Channel ของคุณและตั้งเป็น Admin\n2. Forward ข้อความอะไรก็ได้จาก Channel นั้นมาที่บอทนี้';

    await ctx.replyWithMarkdown(msg);
    // เปลี่ยนสถานะรอรับ Forward
    await prisma.user.update({
        where: { telegramId: BigInt(ctx.from.id) },
        data: { state: 'WAITING_FORWARD' }
    });
});

// ฟังก์ชันรับการ Forward ข้อความ (เพื่อเพิ่ม Channel)
bot.on('message', async (ctx, next) => {
    const user = await getOrCreateUser(ctx);
    const msg = ctx.message as any;

    // CASE: เพิ่ม Channel ด้วยการ Forward
    if (user.state === 'WAITING_FORWARD' && msg.forward_from_chat) {
        const chat = msg.forward_from_chat;
        
        if (chat.type !== 'channel') {
            return ctx.reply('❌ นี่ไม่ใช่ Channel ครับ กรุณา Forward จาก Channel เท่านั้น');
        }

        try {
            // เช็คว่าบอทเป็น Admin ในนั้นจริงไหม
            const admins = await ctx.telegram.getChatAdministrators(chat.id);
            const me = await ctx.telegram.getMe();
            const isAdmin = admins.some(a => a.user.id === me.id);

            if (!isAdmin) {
                return ctx.reply('⚠️ บอทยังไม่ได้เป็น Admin ใน Channel นั้นครับ เชิญบอทเข้าก่อนนะ');
            }

            // บันทึกลง DB
            // เช็คว่ามีอยู่แล้วไหม
            const existing = await prisma.channel.findUnique({ where: { telegramId: BigInt(chat.id) } });
            
            if (!existing) {
                await prisma.channel.create({
                    data: {
                        telegramId: BigInt(chat.id),
                        title: chat.title || 'Untitled Channel',
                        addedById: user.id
                    }
                });
                await ctx.reply(`✅ เพิ่มแชนแนล **"${chat.title}"** เรียบร้อย!`, mainMenu);
            } else {
                await ctx.reply('⚠️ แชนแนลนี้ถูกเพิ่มไปแล้วครับ', mainMenu);
            }

            // Reset State
            await prisma.user.update({
                where: { telegramId: BigInt(ctx.from.id) },
                data: { state: 'IDLE' }
            });

        } catch (e) {
            console.error(e);
            ctx.reply('❌ เกิดข้อผิดพลาด บอทอาจจะเข้าถึง Channel ไม่ได้');
        }
        return;
    }
    
    // ถ้าไม่ใช่การ Forward ให้ส่งไป process text ปกติ
    next();
});

// --- 3. สร้างโพสต์ (Create Post Logic) ---
bot.action('MENU_CREATE', async (ctx) => {
    if (!ctx.from) return;
    const user = await getOrCreateUser(ctx);
    
    // ดึง Channel มาให้เลือก
    const channels = await prisma.channel.findMany({
        where: { addedById: user.id }
    });

    if (channels.length === 0) {
        return ctx.reply('❌ คุณยังไม่ได้เพิ่ม Channel เลยครับ ไปเมนู "จัดการแชนแนล" ก่อนนะ');
    }

    // สร้างปุ่มเลือก Channel
    const buttons = channels.map(ch => [
        Markup.button.callback(ch.title, `SELECT_CH_${ch.id}`)
    ]);
    
    // ปุ่มยกเลิก
    buttons.push([Markup.button.callback('🔙 ยกเลิก', 'CANCEL_ACTION')]);

    await ctx.editMessageText('เลือกแชนแนลที่จะโพสต์:', Markup.inlineKeyboard(buttons));
});

// รับค่าตอนกดเลือก Channel
bot.action(/^SELECT_CH_(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const channelId = ctx.match[1];
    
    // จำว่าเลือก Channel ไหน + เปลี่ยนสถานะเป็นรอรับข้อความ
    await prisma.user.update({
        where: { telegramId: BigInt(ctx.from.id) },
        data: { 
            state: 'WAITING_CONTENT', 
            selectedChannelId: channelId,
            draft: ''
        }
    });

    await ctx.reply('📝 ส่งข้อความ หรือ รูปภาพ ที่ต้องการโพสต์มาได้เลยครับ (รองรับ HTML/Markdown)');
    await ctx.answerCbQuery();
});

// --- 4. จัดการเนื้อหาและปุ่ม (Content Handler) ---
bot.on('text', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const text = ctx.message.text;

    // รับเนื้อหาโพสต์
    if (user.state === 'WAITING_CONTENT') {
        await prisma.user.update({
            where: { telegramId: BigInt(ctx.from.id) },
            data: { draft: text, state: 'WAITING_BUTTONS' }
        });

        await ctx.reply(
            '✅ ได้รับข้อความแล้ว!\n\nต่อไปส่ง **URL Buttons** (หรือพิมพ์ "skip"): \nรูปแบบ: ชื่อปุ่ม - http://link.com'
        );
    } 
    // รับปุ่ม
    else if (user.state === 'WAITING_BUTTONS') {
        let inlineKeyboard: any[] = [];
        if (text.toLowerCase() !== 'skip') {
             const lines = text.split('\n');
             lines.forEach(line => {
                 const parts = line.split(' - ');
                 if (parts.length >= 2) {
                     inlineKeyboard.push([Markup.button.url(parts[0].trim(), parts[1].trim())]);
                 }
             });
        }
        
        // ปุ่ม Confirm
        inlineKeyboard.push([
            Markup.button.callback('🚀 โพสต์ลง Channel เดี๋ยวนี้', 'CONFIRM_POST'),
            Markup.button.callback('❌ ยกเลิก', 'CANCEL_ACTION')
        ]);

        await ctx.replyWithMarkdown(`*ตัวอย่างโพสต์:* \n\n${user.draft}`, Markup.inlineKeyboard(inlineKeyboard));
    }
});

// --- 5. ยืนยันโพสต์ลง Channel จริง ---
bot.action('CONFIRM_POST', async (ctx) => {
    if (!ctx.from) return;
    const user = await prisma.user.findUnique({ 
        where: { telegramId: BigInt(ctx.from.id) },
        include: { channels: true } // ดึงข้อมูล Channel มาด้วย
    });

    if (!user || !user.draft || !user.selectedChannelId) return;

    // หา Channel ที่ User เลือกไว้
    const targetChannel = await prisma.channel.findUnique({ where: { id: user.selectedChannelId } });
    
    if (targetChannel) {
        try {
            // *** จุดไคลแม็กซ์: ส่งเข้า Channel จริงๆ ***
            // ดึงปุ่มจากข้อความต้นฉบับ (Context)
            const replyMarkup = ctx.callbackQuery.message?.reply_markup;
            // ลบปุ่ม Confirm/Cancel ออกก่อนส่ง (อันนี้ต้องเขียน Logic กรองปุ่ม แต่อย่างง่ายคือส่ง Text ไปก่อน)
            
            // หมายเหตุ: การดึงปุ่มเดิมมาส่งต้องใช้เทคนิคขั้นสูงนิดนึง
            // เพื่อความง่ายใน Tutorial นี้ ผมจะส่ง Text ล้วนไปก่อน หรือปุ่มที่ Parse ใหม่
            
            await ctx.telegram.sendMessage(Number(targetChannel.telegramId), user.draft, {
                parse_mode: 'Markdown'
            });

            await ctx.reply(`✅ โพสต์ลงแชนแนล **${targetChannel.title}** เรียบร้อย!`, mainMenu);
        } catch (err) {
            console.error(err);
            await ctx.reply(`❌ ส่งไม่ผ่าน! บอทอาจจะหลุดจาก Admin หรือ Channel ID ผิด`);
        }
    }

    // Reset State
    await prisma.user.update({
        where: { telegramId: BigInt(ctx.from.id) },
        data: { state: 'IDLE', draft: '', selectedChannelId: null }
    });
});

bot.action('CANCEL_ACTION', async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply('❌ ยกเลิกรายการแล้ว', mainMenu);
    await prisma.user.update({
        where: { telegramId: BigInt(ctx.from.id) },
        data: { state: 'IDLE', draft: '', selectedChannelId: null }
    });
});

bot.launch().then(() => console.log('Bot Started'));

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Update bot V2