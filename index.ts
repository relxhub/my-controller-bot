import { Telegraf, Markup } from 'telegraf';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as cron from 'node-cron';

dotenv.config();

if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN is missing');

const bot = new Telegraf(process.env.BOT_TOKEN);
const prisma = new PrismaClient();
const ADMIN_ID = process.env.ADMIN_ID;

// --- Middleware: Security Check ---
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();

  const senderId = String(ctx.from.id);

  // 1. อนุญาตเสมอถ้าเป็น Super Admin ใน .env
  if (ADMIN_ID && senderId === ADMIN_ID) return next();

  // 2. เช็คว่ามีรายชื่ออยู่ใน Database หรือไม่ (เพิ่มผ่าน Prisma Studio)
  try {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(senderId) } });
    if (user) return next();
  } catch (e) {
    console.error('DB Error checking user:', e);
  }

  console.log(`Unauthorized access attempt from: ${senderId} (${ctx.from.username})`);
  return; // ปฏิเสธการเข้าถึง
});

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

// ฟังก์ชันแปลงข้อความเวลา และลบ 7 ชั่วโมงสำหรับ Server (ถ้าไม่ได้ตั้งค่า TZ ใน Railway)
function parseDateTime(text: string): Date | null {
    try {
        const [datePart, timePart] = text.split(' ');
        const [day, month, year] = datePart.split('/').map(Number);
        const [hour, minute] = timePart.split(':').map(Number);
        
        // สร้าง Date (ปรับเวลาให้ตรงกับไทย หาก Server เป็น UTC)
        // ถ้าคุณตั้งค่า TZ=Asia/Bangkok ใน Railway แล้ว ให้ใช้ new Date(year, month-1, day, hour, minute) ปกติ
        // แต่เพื่อความชัวร์ ใช้แบบ UTC แล้วลบ offset เอาดีกว่า
        // UTC+7 (ไทย) -> UTC 0 (Server) ต้องลบ 7 ชม.
        
        // *หมายเหตุ:* ถ้าตั้งตัวแปร TZ ใน Railway แล้ว โค้ดนี้อาจจะทำให้เวลาเพี้ยนได้
        // ดังนั้นผมแนะนำให้ใช้รูปแบบมาตรฐานและให้ Railway จัดการ TZ
        const date = new Date(year, month - 1, day, hour, minute);
        
        if (isNaN(date.getTime())) return null;
        return date;
    } catch {
        return null;
    }
}

// --- Cron Job (ทำงานทุก 1 นาที) ---
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const tasks = await prisma.scheduledPost.findMany({
        where: { postAt: { lte: now } }
    });

    for (const task of tasks) {
        try {
            const data = JSON.parse(task.data);
            
            const extraOptions: any = { parse_mode: 'Markdown' };
            if (data.buttons) {
                extraOptions.reply_markup = data.buttons;
            }

            if (data.type === 'photo') {
                await bot.telegram.sendPhoto(Number(task.channelId), data.fileId, {
                    caption: data.content,
                    ...extraOptions
                });
            } else if (data.type === 'video') {
                await bot.telegram.sendVideo(Number(task.channelId), data.fileId, {
                    caption: data.content,
                    ...extraOptions
                });
            } else {
                await bot.telegram.sendMessage(Number(task.channelId), data.content, extraOptions);
            }

            // แจ้งเตือนเจ้าของ
            await bot.telegram.sendMessage(Number(task.submittedBy), `✅ โพสต์งาน ID: ${task.id} เรียบร้อยแล้วครับ!`);

        } catch (error) {
            console.error(`Failed to send task ${task.id}:`, error);
        }

        // ลบออกจากคิว
        await prisma.scheduledPost.delete({ where: { id: task.id } });
    }
});

// --- Menus ---
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📝 สร้างโพสต์ใหม่ (Create)', 'MENU_CREATE')],
  [Markup.button.callback('⏳ รายการที่ตั้งเวลาไว้ (Scheduled)', 'MENU_SCHEDULED')], // <-- ปุ่มใหม่
  [Markup.button.callback('📢 จัดการแชนแนล (Channels)', 'MENU_CHANNELS')],
  [Markup.button.callback('❓ วิธีใช้งาน', 'MENU_HELP')]
]);

// --- Bot Start ---
bot.start(async (ctx) => {
  await getOrCreateUser(ctx);
  await prisma.user.update({
    where: { telegramId: BigInt(ctx.from.id) },
    data: { state: 'IDLE', draft: '', selectedChannelId: null }
  });
  
  await ctx.reply('👋 สวัสดีครับ! ยินดีต้อนรับสู่ ControllerBot ส่วนตัวของคุณ\nเลือกเมนูด้านล่างได้เลยครับ:', mainMenu);
});

bot.action('MENU_HELP', async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply('💡 **วิธีใช้งาน:**\n1. กด "จัดการแชนแนล" เพื่อเพิ่ม Channel\n2. กด "สร้างโพสต์ใหม่" เพื่อเริ่มโพสต์\n3. กด "รายการที่ตั้งเวลาไว้" เพื่อดูลบโพสต์ที่รอคิว');
    await ctx.answerCbQuery();
});

// --- [NEW] Scheduled Posts Management ---
bot.action('MENU_SCHEDULED', async (ctx) => {
    if (!ctx.from) return;
    const user = await getOrCreateUser(ctx);

    // ดึงรายการที่ user คนนี้ตั้งไว้ โดยเรียงตามเวลา
    const posts = await prisma.scheduledPost.findMany({
        where: { submittedBy: BigInt(ctx.from.id) },
        orderBy: { postAt: 'asc' }
    });

    if (posts.length === 0) {
        await ctx.reply('📭 ไม่มีโพสต์ที่ตั้งเวลาไว้ครับ', mainMenu);
        return ctx.answerCbQuery();
    }

    let msg = '⏳ **รายการที่ตั้งเวลาไว้:**\n\n';
    const buttons = [];

    for (const post of posts) {
        // แปลงเวลาให้ดูง่าย (แบบไทย)
        const timeStr = post.postAt.toLocaleString('th-TH', { 
            timeZone: 'Asia/Bangkok', 
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' 
        });

        // ดึงตัวอย่างเนื้อหา
        let contentPreview = '...';
        try {
            const d = JSON.parse(post.data);
            contentPreview = d.content ? d.content.substring(0, 30) : (d.type === 'photo' ? '[รูปภาพ]' : (d.type === 'video' ? '[วิดีโอ]' : '...'));
        } catch {}

        msg += `🔹 **ID:** ${post.id} | 📅 ${timeStr}\n📝 ${contentPreview}\n\n`;
        
        // ปุ่มลบ
        buttons.push([Markup.button.callback(`❌ ลบรายการ (ID: ${post.id})`, `DEL_SCH_${post.id}`)]);
    }
    
    buttons.push([Markup.button.callback('🔙 กลับเมนูหลัก', 'BACK_MAIN')]);

    await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

// Logic ลบโพสต์
bot.action(/^DEL_SCH_(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const postId = Number(ctx.match[1]);

    try {
        await prisma.scheduledPost.delete({ where: { id: postId } });
        await ctx.reply(`✅ ลบรายการ ID: ${postId} เรียบร้อยแล้วครับ!`);
        // กลับไปหน้าเมนูหลัก
        await ctx.reply('เลือกเมนูต่อเลยครับ:', mainMenu);
    } catch (e) {
        await ctx.reply('❌ ไม่สามารถลบได้ (โพสต์อาจจะถูกส่งไปแล้ว หรือไม่มีอยู่จริง)', mainMenu);
    }
    await ctx.answerCbQuery();
});

bot.action('BACK_MAIN', async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply('เลือกเมนูด้านล่าง:', mainMenu);
    await ctx.answerCbQuery();
});

// --- Channel Management ---
bot.action('MENU_CHANNELS', async (ctx) => {
    if (!ctx.from) return;
    const user = await getOrCreateUser(ctx);
    const channels = await prisma.channel.findMany({ where: { addedById: user.id } });

    let msg = '📢 **รายชื่อแชนแนลของคุณ:**\n\n';
    if (channels.length === 0) msg += '❌ ยังไม่มีแชนแนล\n';
    else channels.forEach(ch => msg += `✅ ${ch.title}\n`);

    msg += '\n**วิธีเพิ่มแชนแนล:**\n1. ดึงบอทเข้า Channel และตั้งเป็น Admin\n2. Forward ข้อความจาก Channel นั้นมาที่บอทนี้';

    await ctx.replyWithMarkdown(msg);
    await prisma.user.update({
        where: { telegramId: BigInt(ctx.from.id) },
        data: { state: 'WAITING_FORWARD' }
    });
    await ctx.answerCbQuery();
});

// --- Create Post Flow ---
bot.action('MENU_CREATE', async (ctx) => {
    if (!ctx.from) return;
    const user = await getOrCreateUser(ctx);
    const channels = await prisma.channel.findMany({ where: { addedById: user.id } });

    if (channels.length === 0) {
        return ctx.reply('❌ คุณยังไม่ได้เพิ่ม Channel เลยครับ ไปเมนู "จัดการแชนแนล" ก่อนนะ');
    }

    const buttons = channels.map(ch => [Markup.button.callback(ch.title, `SELECT_CH_${ch.id}`)]);
    buttons.push([Markup.button.callback('🔙 ยกเลิก', 'CANCEL_ACTION')]);

    await ctx.editMessageText('เลือกแชนแนลที่จะโพสต์:', Markup.inlineKeyboard(buttons));
});

bot.action(/^SELECT_CH_(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const channelId = ctx.match[1];
    
    await prisma.user.update({
        where: { telegramId: BigInt(ctx.from.id) },
        data: { state: 'WAITING_CONTENT', selectedChannelId: channelId, draft: '' }
    });

    await ctx.reply('📝 ส่ง **ข้อความ**, **รูปภาพ** หรือ **วิดีโอ** ที่ต้องการโพสต์มาได้เลยครับ');
    await ctx.answerCbQuery();
});

// --- Message Handler ---
bot.on(['text', 'photo', 'video'], async (ctx, next) => {
    const msg = ctx.message as any;
    const user = await getOrCreateUser(ctx);

    if (msg.forward_from_chat) {
        if (user.state === 'WAITING_FORWARD') {
            const chat = msg.forward_from_chat;
            if (chat.type !== 'channel') return ctx.reply('❌ รองรับเฉพาะ Channel เท่านั้นครับ');

            try {
                const existing = await prisma.channel.findUnique({ where: { telegramId: BigInt(chat.id) } });
                if (!existing) {
                    await prisma.channel.create({
                        data: { telegramId: BigInt(chat.id), title: chat.title || 'Untitled', addedById: user.id }
                    });
                    await ctx.reply(`✅ เพิ่มแชนแนล **"${chat.title}"** เรียบร้อย!`, mainMenu);
                } else {
                    await ctx.reply('⚠️ แชนแนลนี้ถูกเพิ่มไปแล้วครับ', mainMenu);
                }
                await prisma.user.update({ where: { telegramId: BigInt(ctx.from.id) }, data: { state: 'IDLE' } });
            } catch (e) {
                console.error(e);
                ctx.reply('❌ เกิดข้อผิดพลาด! บอทอาจจะยังไม่ได้เป็น Admin ใน Channel นั้น');
            }
        }
        return;
    }

    if (user.state === 'WAITING_CONTENT') {
        let draftData: any = { type: 'text', content: msg.text || '' };

        if (msg.photo) {
            draftData = { 
                type: 'photo', 
                fileId: msg.photo[msg.photo.length - 1].file_id, 
                content: msg.caption || '' 
            };
        } else if (msg.video) {
            draftData = {
                type: 'video',
                fileId: msg.video.file_id,
                content: msg.caption || ''
            };
        }

        await prisma.user.update({
            where: { telegramId: BigInt(ctx.from.id) },
            data: { draft: JSON.stringify(draftData), state: 'WAITING_BUTTONS' }
        });

        await ctx.reply('✅ บันทึกเนื้อหาแล้ว!\n\nส่ง **URL Buttons** (หรือพิมพ์ "skip")\nรูปแบบ: `Google - https://google.com`', { parse_mode: 'Markdown' });
    }
    
    else if (user.state === 'WAITING_BUTTONS') {
        const text = msg.text || '';
        let inlineKeyboard: any[] = [];
        
        if (text.toLowerCase() !== 'skip') {
             const lines = text.split('\n');
             lines.forEach((line: string) => {
                 const p = line.split(' - ');
                 if (p.length >= 2) inlineKeyboard.push([Markup.button.url(p[0].trim(), p[1].trim())]);
             });
        }
        
        inlineKeyboard.push([
            Markup.button.callback('🚀 โพสต์เลย', 'CONFIRM_POST'),
            Markup.button.callback('📅 ตั้งเวลาโพสต์', 'BTN_SCHEDULE')
        ]);
        inlineKeyboard.push([Markup.button.callback('❌ ยกเลิก', 'CANCEL_ACTION')]);

        let draftObj: any = {};
        try { draftObj = JSON.parse(user.draft || '{}'); } catch(e){}
        
        const kbd = Markup.inlineKeyboard(inlineKeyboard);

        if (draftObj.type === 'photo') {
            await ctx.replyWithPhoto(draftObj.fileId, { caption: `*Preview:*\n${draftObj.content}`, reply_markup: kbd.reply_markup, parse_mode: 'Markdown' });
        } else if (draftObj.type === 'video') {
            await ctx.replyWithVideo(draftObj.fileId, { caption: `*Preview:*\n${draftObj.content}`, reply_markup: kbd.reply_markup, parse_mode: 'Markdown' });
        } else {
            await ctx.replyWithMarkdown(`*Preview:*\n${draftObj.content}`, kbd);
        }
    }

    else if (user.state === 'WAITING_SCHEDULE_TIME') {
        const timeStr = msg.text;
        const postDate = parseDateTime(timeStr);

        if (!postDate) {
            return ctx.reply('❌ รูปแบบผิด! ขอแบบนี้: DD/MM/YYYY HH:MM\nเช่น 25/12/2023 09:00');
        }
        if (postDate <= new Date()) {
            return ctx.reply('⚠️ เวลานี้ผ่านไปแล้วครับ ขอเป็นอนาคตนะ');
        }

        const targetChannel = await prisma.channel.findUnique({ where: { id: user.selectedChannelId! } });
        let draftObj = JSON.parse(user.draft || '{}');
        
        await prisma.scheduledPost.create({
            data: {
                channelId: targetChannel!.telegramId,
                data: JSON.stringify(draftObj),
                postAt: postDate,
                submittedBy: BigInt(ctx.from.id)
            }
        });

        await ctx.reply(`✅ **ตั้งเวลาโพสต์เรียบร้อย!**\nจะโพสต์วันที่: ${timeStr}\n(หากต้องการลบ ให้กดเมนู 'รายการที่ตั้งเวลาไว้')`, mainMenu);
        
        await prisma.user.update({
             where: { telegramId: BigInt(ctx.from.id) },
             data: { state: 'IDLE', draft: '', selectedChannelId: null }
        });
    }
});

// --- Actions ---

bot.action('BTN_SCHEDULE', async (ctx) => {
    if (!ctx.from) return;
    
    const message = ctx.callbackQuery.message as any;
    const currentMarkup = message?.reply_markup;

    if (currentMarkup && currentMarkup.inline_keyboard) {
        currentMarkup.inline_keyboard.pop(); 
        currentMarkup.inline_keyboard.pop();
    }

    const user = await getOrCreateUser(ctx);
    let draftObj = JSON.parse(user.draft || '{}');
    draftObj.buttons = currentMarkup;

    await prisma.user.update({
        where: { telegramId: BigInt(ctx.from.id) },
        data: { 
            state: 'WAITING_SCHEDULE_TIME', 
            draft: JSON.stringify(draftObj)
        }
    });

    await ctx.reply('📅 พิมพ์วันเวลาที่ต้องการโพสต์ (DD/MM/YYYY HH:MM):');
    await ctx.answerCbQuery();
});

bot.action('CONFIRM_POST', async (ctx) => {
    if (!ctx.from) return;
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
    if (!user || !user.draft || !user.selectedChannelId) return;

    const targetChannel = await prisma.channel.findUnique({ where: { id: user.selectedChannelId } });
    
    if (targetChannel) {
        try {
            const message = ctx.callbackQuery.message as any;
            const replyMarkup = message?.reply_markup;
            
            if (replyMarkup && replyMarkup.inline_keyboard) {
                replyMarkup.inline_keyboard.pop();
                replyMarkup.inline_keyboard.pop();
            }

            const draftObj = JSON.parse(user.draft);

            if (draftObj.type === 'photo') {
                await ctx.telegram.sendPhoto(Number(targetChannel.telegramId), draftObj.fileId, {
                    caption: draftObj.content,
                    reply_markup: replyMarkup,
                    parse_mode: 'Markdown'
                });
            } else if (draftObj.type === 'video') {
                await ctx.telegram.sendVideo(Number(targetChannel.telegramId), draftObj.fileId, {
                    caption: draftObj.content,
                    reply_markup: replyMarkup,
                    parse_mode: 'Markdown'
                });
            } else {
                await ctx.telegram.sendMessage(Number(targetChannel.telegramId), draftObj.content, {
                    reply_markup: replyMarkup,
                    parse_mode: 'Markdown'
                });
            }

            await ctx.reply('✅ โพสต์เรียบร้อย!', mainMenu);
        } catch (err) {
            console.error(err);
            await ctx.reply('❌ โพสต์ไม่ผ่าน (เช็คสิทธิ์ Admin ใน Channel)');
        }
    }

    await prisma.user.update({
        where: { telegramId: BigInt(ctx.from.id) },
        data: { state: 'IDLE', draft: '', selectedChannelId: null }
    });
    await ctx.answerCbQuery();
});

bot.action('CANCEL_ACTION', async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply('❌ ยกเลิกรายการ', mainMenu);
    await prisma.user.update({
        where: { telegramId: BigInt(ctx.from.id) },
        data: { state: 'IDLE', draft: '', selectedChannelId: null }
    });
    await ctx.answerCbQuery();
});

bot.launch().then(() => console.log('Bot Started'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));