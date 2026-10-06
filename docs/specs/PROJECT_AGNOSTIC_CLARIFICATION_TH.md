# Clarification: MCP เป็น Infrastructure/Tool Layer เท่านั้น

`E:\Remote-MCP-Server` เป็น infrastructure/tool layer เท่านั้น

MCP มีหน้าที่ให้ ChatGPT:

- เข้าถึงเครื่อง
- filesystem/search
- terminal/process/jobs
- GUI/browser
- approval
- security/credentials
- reconnect
- operational audit
- runtime state

ห้ามเอาความรู้เฉพาะโปรเจกต์ไปเก็บรวมเป็นความจำของ MCP เช่น:

- Project Overview
- Billboard
- Checklist
- `WORK_CHECKPOINT.md`
- project history
- workflow เฉพาะงาน
- research
- sources
- production status
- rules ของแต่ละ project

ข้อมูลเหล่านี้ต้องอยู่ภายใน project นั้นเอง เช่น:

```text
E:\Project-A\WORK_CHECKPOINT.md
E:\Project-A\PROJECT_OVERVIEW.md
E:\Project-A\docs\...
```

ไม่ใช่:

```text
E:\Remote-MCP-Server\memory\Project-A\...
```

MCP สามารถมี helper สำหรับ `discover/read/update project checkpoint` ได้ แต่ helper เป็นเพียงเครื่องมือ ส่วนข้อมูลจริงยังต้องอยู่ใน project

Persistent state ของ MCP ให้เก็บเฉพาะ operational state เช่น:

- active MCP sessions
- running job IDs
- pending approvals
- process tracking
- watches
- schedules
- MCP audit history
- artifact references/path mapping

ต้อง namespace ตาม workspace/session ให้ชัดเจน เพื่อไม่ให้ state ของ Project A ปนกับ Project B

**MCP must not impose a project workflow.**

แต่ละ project เป็นเจ้าของ workflow, memory, documentation และ rules ของตัวเอง

เมื่อ ChatGPT เข้า project ใหม่ ให้ MCP เพียงช่วยค้นหาไฟล์ประเภท README / PROJECT_OVERVIEW / WORK_CHECKPOINT / rules / workflow แล้วให้ ChatGPT อ่านและทำงานตาม project นั้น

**Remote MCP should remain universal and project-agnostic.**

วันนี้ใช้ผลิตวิดีโอ พรุ่งนี้ใช้เขียนโปรแกรม อีกวันใช้จัดไฟล์หรือทำ automation ก็ต้องใช้ server ตัวเดิมได้ โดยไม่ต้องดัดแปลง core MCP ตามแต่ละ project

นอกเหนือจาก clarification นี้ ให้เดินงานตาม Master Spec และคำสั่งก่อนหน้าได้ต่อเนื่อง ไม่ต้องหยุดถามเพิ่มถ้าไม่มี blocker หรือ risky approval จริง
