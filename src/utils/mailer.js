const nodemailer = require('nodemailer');
require('dotenv').config();

const createTransporter = () => {
  // Check if SMTP user/pass is set
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

const sendVerificationEmail = async (email, code) => {
  const transporter = createTransporter();

  if (!transporter) {
    console.log('\n======================================================');
    console.log(`📨 [Mail Development Fallback]`);
    console.log(`To Verify Email: ${email}`);
    console.log(`Verification Code: ${code}`);
    console.log('======================================================\n');
    return { devFallback: true, code };
  }

  const mailOptions = {
    from: `"Code Clover 🍀" <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'Code Clover 🍀 Verify Your Email Account',
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 20px; padding: 30px; background-color: #FFFFFF;">
        <div style="text-align: center; margin-bottom: 25px;">
          <span style="font-size: 50px;">🍀</span>
          <h2 style="color: #2E7D32; margin-top: 10px; font-weight: 800; letter-spacing: -0.5px;">Code Clover</h2>
          <p style="color: #64748B; font-size: 14px; margin-top: -5px;">Consistency is learning. Growth is luck.</p>
        </div>
        <p style="color: #334155; font-size: 15px; line-height: 1.5;">Welcome to Code Clover! We're excited to have you join our learning community. To verify your email address, please use the 6-digit confirmation code below:</p>
        <div style="background-color: #F1F8E9; border: 1px dashed #A5D6A7; border-radius: 12px; text-align: center; padding: 15px; margin: 25px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #1B5E20; font-family: monospace;">${code}</span>
        </div>
        <p style="color: #64748B; font-size: 11px; text-align: center; margin-top: 30px;">This code will expire in 15 minutes. If you did not sign up for Code Clover, you can safely ignore this email.</p>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`🍀 [Mailer] Verification email sent to: ${email} (Message ID: ${info.messageId})`);
    return info;
  } catch (err) {
    console.error(`❌ [Mailer] Failed to send email to ${email}:`, err.message);
    // Console fallback on error
    console.log('\n======================================================');
    console.log(`📨 [Mail Fallback - SMTP Error]`);
    console.log(`To Verify Email: ${email}`);
    console.log(`Verification Code: ${code}`);
    console.log('======================================================\n');
    return { error: err.message, code };
  }
};

const sendStudyPlanEmail = async (email, username, notes, reportMarkdown) => {
  const transporter = createTransporter();

  if (!transporter) {
    console.log('\n======================================================');
    console.log(`📨 [Mail Development Fallback - Study Plan]`);
    console.log(`Sending to Email: ${email}`);
    console.log(`Study Plan for: ${username}`);
    console.log(`Notes: ${notes}`);
    console.log(`Insights Report:\n${reportMarkdown}`);
    console.log('======================================================\n');
    return { devFallback: true };
  }

  // Convert markdown list blocks to basic HTML structure
  const formattedReport = reportMarkdown
    .replace(/### (.*)/g, '<h3 style="color: #2E7D32; border-bottom: 1px solid #E8F5E9; pb-5;">$1</h3>')
    .replace(/#### (.*)/g, '<h4 style="color: #1B5E20; margin-top: 15px;">$1</h4>')
    .replace(/\*\*(.*)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background-color: #F1F8E9; padding: 2px 6px; border-radius: 4px; color: #2E7D32;">$1</code>')
    .replace(/\n/g, '<br/>');

  const mailOptions = {
    from: `"Code Clover 🍀" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `Code Clover 🍀 Your Daily Study Plan & AI Insights`,
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 20px; padding: 30px; background-color: #FFFFFF;">
        <div style="text-align: center; border-bottom: 1px solid #F1F5F9; padding-bottom: 15px; margin-bottom: 20px;">
          <span style="font-size: 40px;">🍀</span>
          <h2 style="color: #2E7D32; margin: 5px 0 0 0; font-weight: 800;">Your Study Plan & AI Insights</h2>
          <p style="color: #94A3B8; font-size: 12px; margin: 2px 0 0 0;">Student: ${username} • Date: ${new Date().toLocaleDateString()}</p>
        </div>
        
        ${notes ? `
          <div style="background-color: #F8FAFC; border-left: 4px solid #94A3B8; border-radius: 0 12px 12px 0; padding: 15px; margin-bottom: 25px;">
            <strong style="color: #475569; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Your Notes:</strong>
            <p style="color: #334155; font-size: 14px; italic; margin-top: 5px; margin-bottom: 0;">"${notes}"</p>
          </div>
        ` : ''}

        <div style="color: #334155; font-size: 14px; line-height: 1.6;">
          ${formattedReport}
        </div>
        
        <div style="text-align: center; border-top: 1px solid #F1F5F9; padding-top: 20px; margin-top: 30px; color: #94A3B8; font-size: 11px;">
          <p>Keep up the consistency! Log focus timer sessions daily on Code Clover 🍀 to earn streak badges.</p>
        </div>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`🍀 [Mailer] Study plan emailed successfully to: ${email}`);
    return info;
  } catch (err) {
    console.error(`❌ [Mailer] Failed to email study plan to ${email}:`, err.message);
    return { error: err.message };
  }
};

const sendDailyGoalsReminderEmail = async (email, username, goals) => {
  const transporter = createTransporter();

  const goalsListHtml = goals.map(goal => {
    const percent = Math.min(100, Math.round((Number(goal.current_hours) / Number(goal.target_hours)) * 100));
    return `
      <li style="margin-bottom: 15px; padding: 12px; background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; list-style-type: none;">
        <strong style="color: #1E293B; font-size: 15px;">${goal.title}</strong><br/>
        <span style="font-size: 12px; color: #64748B;">Category: <strong>${goal.category}</strong></span><br/>
        <div style="margin-top: 8px; background-color: #E2E8F0; border-radius: 4px; height: 8px; overflow: hidden; width: 100%;">
          <div style="background-color: #10B981; height: 100%; width: ${percent}%;"></div>
        </div>
        <span style="font-size: 11px; color: #475569; display: block; margin-top: 5px;">
          Progress: <strong>${goal.current_hours} hrs</strong> of <strong>${goal.target_hours} hrs</strong> target (${percent}% completed)
        </span>
      </li>
    `;
  }).join('');

  if (!transporter) {
    console.log('\n======================================================');
    console.log(`📨 [Mail Development Fallback - Goals Reminder]`);
    console.log(`Sending to Email: ${email}`);
    console.log(`Goals Reminder for: ${username}`);
    console.log(`Goals List:\n`, goals.map(g => `- ${g.title} (${g.current_hours}/${g.target_hours}h)`).join('\n'));
    console.log('======================================================\n');
    return { devFallback: true };
  }

  const mailOptions = {
    from: `"Code Clover 🍀" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `Code Clover 🍀 Daily Reminder: Don't forget your study goals today!`,
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 550px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 20px; padding: 30px; background-color: #FFFFFF;">
        <div style="text-align: center; border-bottom: 1px solid #F1F5F9; padding-bottom: 15px; margin-bottom: 20px;">
          <span style="font-size: 40px;">🍀</span>
          <h2 style="color: #10B981; margin: 5px 0 0 0; font-weight: 800; letter-spacing: -0.5px;">Your Study Goals Reminder</h2>
          <p style="color: #94A3B8; font-size: 12px; margin: 2px 0 0 0;">Student: ${username} • Date: ${new Date().toLocaleDateString()}</p>
        </div>
        
        <p style="color: #334155; font-size: 14px; line-height: 1.6;">
          Hello <strong>${username}</strong>,<br/><br/>
          This is a friendly reminder that you have incomplete study goals scheduled for completion today. Make sure to launch your Focus Timer, log study sessions, and check off your targets!
        </p>

        <h3 style="color: #047857; border-bottom: 2px solid #ECFDF5; padding-bottom: 8px; margin-top: 25px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px;">Today's Study Todos:</h3>
        <ul style="padding: 0; margin: 15px 0 25px 0;">
          ${goalsListHtml}
        </ul>
        
        <div style="text-align: center; margin-top: 35px; border-top: 1px solid #F1F5F9; padding-top: 20px; color: #94A3B8; font-size: 11px;">
          <p>Stay consistent, build streaks, and unlock achievements on Code Clover 🍀.</p>
        </div>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`🍀 [Mailer] Daily goals reminder emailed successfully to: ${email}`);
    return info;
  } catch (err) {
    console.error(`❌ [Mailer] Failed to email daily goals reminder to ${email}:`, err.message);
    return { error: err.message };
  }
};

const sendSmartGoalReminderEmail = async (email, username, goal, minutesLeft) => {
  const transporter = createTransporter();

  if (!transporter) {
    console.log('\n======================================================');
    console.log(`📨 [Mail Development Fallback - Smart Goal]`);
    console.log(`Sending to Email: ${email}`);
    console.log(`Smart Goal Reminder in ${minutesLeft} mins for: ${username}`);
    console.log(`Goal: ${goal.title}`);
    console.log('======================================================\n');
    return { devFallback: true };
  }

  const mailOptions = {
    from: `"Code Clover 🍀" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `Code Clover 🍀 Reminder: ${goal.title} starts in ${minutesLeft} minutes!`,
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 550px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 20px; padding: 30px; background-color: #FFFFFF;">
        <div style="text-align: center; border-bottom: 1px solid #F1F5F9; padding-bottom: 15px; margin-bottom: 20px;">
          <span style="font-size: 40px;">🍀</span>
          <h2 style="color: #10B981; margin: 5px 0 0 0; font-weight: 800; letter-spacing: -0.5px;">Upcoming Study Goal</h2>
          <p style="color: #94A3B8; font-size: 12px; margin: 2px 0 0 0;">Student: ${username} • Date: ${new Date().toLocaleDateString()}</p>
        </div>
        
        <p style="color: #334155; font-size: 14px; line-height: 1.6;">
          Hello <strong>${username}</strong>,<br/><br/>
          Your study session for <strong>${goal.title}</strong> is starting in ${minutesLeft} minutes.
        </p>
        <p style="color: #334155; font-size: 14px; line-height: 1.6;">
          <strong>Why are you doing this?</strong><br/>
          ${goal.reason || 'To learn and grow!'}
        </p>
        
        <div style="text-align: center; margin-top: 35px; border-top: 1px solid #F1F5F9; padding-top: 20px; color: #94A3B8; font-size: 11px;">
          <p>Get ready to focus! Code Clover 🍀.</p>
        </div>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`🍀 [Mailer] Smart goal reminder emailed successfully to: ${email}`);
    return info;
  } catch (err) {
    console.error(`❌ [Mailer] Failed to email smart goal reminder to ${email}:`, err.message);
    return { error: err.message };
  }
};

const sendEarlyQuitEmail = async (email, username, goal, quitReason) => {
  const transporter = createTransporter();

  if (!transporter) {
    console.log('\n======================================================');
    console.log(`📨 [Mail Development Fallback - Early Quit]`);
    console.log(`Sending to Email: ${email}`);
    console.log(`Early Quit for: ${username}`);
    console.log(`Goal: ${goal.title}`);
    console.log(`Reason: ${quitReason}`);
    console.log('======================================================\n');
    return { devFallback: true };
  }

  const mailOptions = {
    from: `"Code Clover 🍀" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `Code Clover 🍀 Goal Interrupted: ${goal.title}`,
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 550px; margin: 0 auto; border: 1px solid #E2E8F0; border-radius: 20px; padding: 30px; background-color: #FFFFFF;">
        <div style="text-align: center; border-bottom: 1px solid #F1F5F9; padding-bottom: 15px; margin-bottom: 20px;">
          <span style="font-size: 40px;">🍀</span>
          <h2 style="color: #E11D48; margin: 5px 0 0 0; font-weight: 800; letter-spacing: -0.5px;">Session Interrupted</h2>
          <p style="color: #94A3B8; font-size: 12px; margin: 2px 0 0 0;">Student: ${username} • Date: ${new Date().toLocaleDateString()}</p>
        </div>
        
        <p style="color: #334155; font-size: 14px; line-height: 1.6;">
          Hello <strong>${username}</strong>,<br/><br/>
          Your study session for <strong>${goal.title}</strong> has been stopped early.
        </p>
        <p style="color: #334155; font-size: 14px; line-height: 1.6;">
          <strong>Recorded Reason:</strong><br/>
          <span style="color: #E11D48;">${quitReason}</span>
        </p>
        
        <div style="text-align: center; margin-top: 35px; border-top: 1px solid #F1F5F9; padding-top: 20px; color: #94A3B8; font-size: 11px;">
          <p>Don't be discouraged! Take a break and get back to learning. Code Clover 🍀.</p>
        </div>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`🍀 [Mailer] Early quit email successfully sent to: ${email}`);
    return info;
  } catch (err) {
    console.error(`❌ [Mailer] Failed to email early quit to ${email}:`, err.message);
    return { error: err.message };
  }
};

module.exports = {
  sendVerificationEmail,
  sendStudyPlanEmail,
  sendDailyGoalsReminderEmail,
  sendSmartGoalReminderEmail,
  sendEarlyQuitEmail
};

