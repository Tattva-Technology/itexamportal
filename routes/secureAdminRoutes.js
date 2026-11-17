const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("../database/postgres");

const router = express.Router();
const attempts = new Map();

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of String(value).replace(/=+$/,"").toUpperCase()) {
    const n = alphabet.indexOf(char);
    if (n < 0) throw new Error("Invalid authenticator secret");
    bits += n.toString(2).padStart(5,"0");
  }
  const bytes = [];
  for (let i=0; i+8<=bits.length; i+=8)
    bytes.push(parseInt(bits.slice(i,i+8),2));
  return Buffer.from(bytes);
}
function totp(secret, counter) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac("sha1",key).update(msg).digest();
  const offset = hash[hash.length-1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6,"0");
}
function verifyTotp(secret, token) {
  if (!/^\d{6}$/.test(String(token || ""))) return false;
  const step = Math.floor(Date.now()/30000);
  return [-1,0,1].some(delta => {
    try { return totp(secret,step+delta) === String(token); }
    catch { return false; }
  });
}
async function audit(adminId, action, detail = "") {
  await pool.query(
    "INSERT INTO portal_admin_audit(admin_id,action,detail) VALUES($1,$2,$3)",
    [adminId, action, String(detail || "").slice(0,500)]
  );
}
async function adminOnly(req,res,next) {
  try {
    if (!req.session?.adminId)
      return res.status(401).json({ error: "Admin login required." });
    const result = await pool.query(
      "SELECT id,email FROM portal_admins WHERE id=$1 AND active=1",
      [req.session.adminId]
    );
    if (!result.rowCount)
      return res.status(401).json({ error: "Admin account unavailable." });
    req.admin = result.rows[0];
    next();
  } catch (error) { next(error); }
}
function id(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

router.post("/login", async (req,res,next) => {
  try {
    const ip = req.ip || "unknown";
    const state = attempts.get(ip) || { count: 0, until: 0 };
    if (Date.now() < state.until)
      return res.status(429).json({ error: "Too many login attempts. Try again later." });

    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const code = String(req.body.code || "");
    const result = await pool.query(
      "SELECT * FROM portal_admins WHERE email=$1 AND active=1", [email]
    );
    const admin = result.rows[0];
    const passwordOk = admin ? await bcrypt.compare(password,admin.password_hash) : false;
    const codeOk = admin ? verifyTotp(admin.totp_secret,code) : false;

    if (!passwordOk || !codeOk) {
      state.count++;
      if (state.count >= 5) {
        state.count = 0;
        state.until = Date.now() + 15*60*1000;
      }
      attempts.set(ip,state);
      return res.status(401).json({ error: "Invalid admin credentials or authenticator code." });
    }

    attempts.delete(ip);
    req.session.regenerate(async error => {
      if (error) return res.status(500).json({ error: "Could not create secure session." });
      req.session.adminId = admin.id;
      req.session.save(async saveError => {
        if (saveError) return res.status(500).json({ error: "Could not save admin session." });
        try {
          await audit(admin.id,"LOGIN");
          res.json({ ok: true, email: admin.email });
        } catch (auditError) { next(auditError); }
      });
    });
  } catch (error) { next(error); }
});

router.get("/me",adminOnly,(req,res)=>res.json({admin:req.admin}));

router.post("/logout",adminOnly,async (req,res,next)=>{
  try {
    await audit(req.admin.id,"LOGOUT");
    req.session.destroy(error => {
      if (error) return res.status(500).json({ error: "Could not end session." });
      res.clearCookie("itexamportal.sid");
      res.json({ok:true});
    });
  } catch (error) { next(error); }
});

router.get("/materials",adminOnly,async (req,res,next)=>{
  try {
    const result = await pool.query("SELECT * FROM it_study_materials ORDER BY id DESC");
    res.json({materials:result.rows});
  } catch(error){next(error);}
});

router.post("/materials",adminOnly,async (req,res,next)=>{
  try {
    const {chapter,title,description,content,file_url,material_type,publish} = req.body;
    if (!chapter || !title)
      return res.status(400).json({error:"Chapter and title are required."});
    const result = await pool.query(`
      INSERT INTO it_study_materials
      (chapter,title,description,content,file_url,material_type,is_published)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `,[
      String(chapter).slice(0,150),String(title).slice(0,200),
      String(description||""),String(content||""),String(file_url||""),
      String(material_type||"Notes").slice(0,50),publish?1:0
    ]);
    await audit(req.admin.id,"CREATE_MATERIAL","Material ID "+result.rows[0].id);
    res.json({ok:true,id:result.rows[0].id});
  } catch(error){next(error);}
});

router.post("/materials/:id/publish",adminOnly,async (req,res,next)=>{
  try {
    const materialId=id(req.params.id);
    if(!materialId)return res.status(400).json({error:"Invalid material ID."});
    const result=await pool.query(
      "UPDATE it_study_materials SET is_published=$1 WHERE id=$2",
      [req.body.publish?1:0,materialId]
    );
    if(!result.rowCount)return res.status(404).json({error:"Material not found."});
    await audit(req.admin.id,"CHANGE_MATERIAL_PUBLICATION","Material "+materialId);
    res.json({ok:true});
  } catch(error){next(error);}
});

// Records are retained: deletion is deliberately disabled.
router.delete("/materials/:id",adminOnly,(req,res)=>
  res.status(405).json({error:"Deletion is disabled to protect stored records. Unpublish this material instead."})
);

router.get("/practice",adminOnly,async (req,res,next)=>{
  try {
    const result=await pool.query(`
      SELECT id,chapter,question,options_json,correct_option,explanation,is_published
      FROM it_practice_questions ORDER BY id DESC
    `);
    res.json({questions:result.rows.map(q=>({...q,options:
      typeof q.options_json==="string"?JSON.parse(q.options_json):q.options_json
    }))});
  } catch(error){next(error);}
});

router.post("/practice",adminOnly,async (req,res,next)=>{
  try {
    const {chapter,question,options,correct_option,explanation,publish}=req.body;
    if(!chapter||!question||!options||!["A","B","C","D"].includes(correct_option))
      return res.status(400).json({error:"Enter chapter, question, four options and correct answer."});
    for(const key of ["A","B","C","D"])
      if(!String(options[key]||"").trim())
        return res.status(400).json({error:"All four options are required."});
    const result=await pool.query(`
      INSERT INTO it_practice_questions
      (chapter,question,options_json,correct_option,explanation,is_published)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id
    `,[String(chapter),String(question),JSON.stringify(options),correct_option,String(explanation||""),publish?1:0]);
    await audit(req.admin.id,"CREATE_PRACTICE_QUESTION","Question "+result.rows[0].id);
    res.json({ok:true,id:result.rows[0].id});
  } catch(error){next(error);}
});

router.post("/practice/:id/publish",adminOnly,async (req,res,next)=>{
  try {
    const questionId=id(req.params.id);
    if(!questionId)return res.status(400).json({error:"Invalid question ID."});
    const result=await pool.query(
      "UPDATE it_practice_questions SET is_published=$1 WHERE id=$2",
      [req.body.publish?1:0,questionId]
    );
    if(!result.rowCount)return res.status(404).json({error:"Question not found."});
    await audit(req.admin.id,"CHANGE_PRACTICE_PUBLICATION","Question "+questionId);
    res.json({ok:true});
  } catch(error){next(error);}
});

router.delete("/practice/:id",adminOnly,(req,res)=>
  res.status(405).json({error:"Deletion is disabled to protect stored records. Unpublish this question instead."})
);

router.get("/exams",adminOnly,async (req,res,next)=>{
  try {
    const [papers,questions,written]=await Promise.all([
      pool.query("SELECT * FROM student_exam_papers ORDER BY id DESC"),
      pool.query("SELECT id,paper_id,question,marks,correct_option FROM student_exam_questions ORDER BY id DESC"),
      pool.query("SELECT id,paper_id,chapter,question,marks,language FROM portal_written_questions ORDER BY id DESC")
    ]);
    res.json({papers:papers.rows,questions:questions.rows,written:written.rows});
  } catch(error){next(error);}
});

router.post("/exams",adminOnly,async (req,res,next)=>{
  try {
    const {title,exam_date,total_marks}=req.body;
    if(!title||!/^\d{4}-\d{2}-\d{2}$/.test(String(exam_date||"")))
      return res.status(400).json({error:"Enter an exam title and date in YYYY-MM-DD format."});
    const date=new Date(exam_date+"T12:00:00+05:30");
    if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==exam_date||date.getUTCDay()!==0)
      return res.status(400).json({error:"Enter a valid Sunday date."});
    const marks=Number(total_marks||80);
    if(!Number.isInteger(marks)||marks<1||marks>80)
      return res.status(400).json({error:"Total marks must be between 1 and 80."});
    const result=await pool.query(`
      INSERT INTO student_exam_papers
      (title,subject,duration_minutes,total_marks,exam_date,is_published)
      VALUES($1,'Information Technology',150,$2,$3,0) RETURNING id
    `,[String(title).slice(0,200),marks,exam_date]);
    await audit(req.admin.id,"CREATE_EXAM","Paper "+result.rows[0].id);
    res.json({ok:true,id:result.rows[0].id});
  } catch(error){next(error);}
});

router.post("/exams/:id/mcq",adminOnly,async (req,res,next)=>{
  try {
    const paperId=id(req.params.id);
    const {question,options,correct_option,marks,explanation}=req.body;
    if(!paperId||!question||!options||!["A","B","C","D"].includes(correct_option))
      return res.status(400).json({error:"Question, options and correct answer are required."});
    for(const key of ["A","B","C","D"])
      if(!String(options[key]||"").trim())
        return res.status(400).json({error:"All four options are required."});
    const paper=await pool.query("SELECT id FROM student_exam_papers WHERE id=$1",[paperId]);
    if(!paper.rowCount)return res.status(404).json({error:"Paper not found."});
    const result=await pool.query(`
      INSERT INTO student_exam_questions
      (paper_id,question,options_json,correct_option,marks,explanation)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id
    `,[paperId,String(question),JSON.stringify(options),correct_option,Math.max(1,Number(marks)||1),String(explanation||"")]);
    await audit(req.admin.id,"ADD_EXAM_MCQ","Question "+result.rows[0].id);
    res.json({ok:true,id:result.rows[0].id});
  } catch(error){next(error);}
});

router.post("/exams/:id/written",adminOnly,async (req,res,next)=>{
  try {
    const paperId=id(req.params.id);
    const {chapter,question,expected_answer,rubric,marks,language}=req.body;
    if(!paperId||!question||!rubric)
      return res.status(400).json({error:"Written question and marking rubric are required."});
    const paper=await pool.query("SELECT id FROM student_exam_papers WHERE id=$1",[paperId]);
    if(!paper.rowCount)return res.status(404).json({error:"Paper not found."});
    const result=await pool.query(`
      INSERT INTO portal_written_questions
      (paper_id,chapter,question,expected_answer,rubric,marks,language)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `,[paperId,String(chapter||""),String(question),String(expected_answer||""),String(rubric),Math.max(1,Number(marks)||1),String(language||"Theory")]);
    await audit(req.admin.id,"ADD_WRITTEN_EXAM_QUESTION","Question "+result.rows[0].id);
    res.json({ok:true,id:result.rows[0].id});
  } catch(error){next(error);}
});

router.post("/exams/:id/publish",adminOnly,async (req,res,next)=>{
  try {
    const paperId=id(req.params.id);
    if(!paperId)return res.status(400).json({error:"Invalid paper ID."});
    const paperResult=await pool.query("SELECT * FROM student_exam_papers WHERE id=$1",[paperId]);
    if(!paperResult.rowCount)return res.status(404).json({error:"Paper not found."});
    const [mcq,written]=await Promise.all([
      pool.query("SELECT COALESCE(SUM(marks),0)::int AS n FROM student_exam_questions WHERE paper_id=$1",[paperId]),
      pool.query("SELECT COALESCE(SUM(marks),0)::int AS n FROM portal_written_questions WHERE paper_id=$1",[paperId])
    ]);
    const total=mcq.rows[0].n+written.rows[0].n;
    if(total!==Number(paperResult.rows[0].total_marks))
      return res.status(400).json({error:`Question marks total ${total}; paper total is ${paperResult.rows[0].total_marks}. Fix the difference before publishing.`});
    if(mcq.rows[0].n===0)
      return res.status(400).json({error:"At least one MCQ is required. Written-answer delivery and grading must be completed before using written questions."});
    await pool.query("UPDATE student_exam_papers SET is_published=$1 WHERE id=$2",[req.body.publish?1:0,paperId]);
    await audit(req.admin.id,"CHANGE_EXAM_PUBLICATION","Paper "+paperId);
    res.json({ok:true});
  } catch(error){next(error);}
});

router.get("/audit",adminOnly,async (req,res,next)=>{
  try {
    const result=await pool.query(`
      SELECT action,detail,created_at FROM portal_admin_audit
      ORDER BY id DESC LIMIT 200
    `);
    res.json({logs:result.rows});
  } catch(error){next(error);}
});

module.exports=router;
