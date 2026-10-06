# IMPORTANT CHANGE — Authorization Model

ปรับระบบ Permission/Approval ให้ทำงานแบบ persistent trusted access คล้ายประสบการณ์ของ Remote Desktop Commander

เป้าหมายคือ:

**ผู้ใช้อนุญาตเครื่อง/ChatGPT ครั้งเดียว → จากนั้น ChatGPT ทำงานได้ต่อเนื่องเต็มสิทธิ์จนกว่าผู้ใช้จะ revoke**

ไม่ต้องมี Approval popup ทุกครั้งที่แก้/ลบ/ย้ายไฟล์ รัน terminal, restart process/service, install dependency, ใช้ GUI/browser, Git, production/render, long job หรือ system administration

หาก principal/client/device มี valid persistent Full Access Grant แล้ว ให้ action ที่อยู่ภายใต้สิทธิ์ของ Windows account/broker execute ได้ทันที

## 1. First-time authorization

เมื่อ ChatGPT account/client ใหม่เชื่อมเข้ากับเครื่องนี้ ให้ผู้ใช้ยืนยันสิทธิ์ครั้งแรกด้วยตัวเลือกหลัก:

**[Grant Full Access to This Computer]**

เมื่อผู้ใช้อนุญาตแล้ว ให้สร้าง persistent trusted grant ที่ผูกกับ:

- authenticated principal / ChatGPT client identity
- server/device identity
- grant ID
- granted scope
- creation time
- revocation state

Grant ต้อง persist และ survive chat ใหม่, browser refresh, ChatGPT/MCP reconnect, server restart, Windows reboot และหลายวัน/หลายสัปดาห์ โดยไม่มี automatic short expiry เป็นค่า default

สิทธิ์สิ้นสุดเมื่อผู้ใช้ revoke, credential/client ถูกยกเลิก, device ถูก unlink หรือ security reset

## 2. Full Trust Mode

หลังได้รับ Full Access Grant แล้วอย่าขอ permission ซ้ำต่อ action ChatGPT ต้องรับงานยาวหลายชั่วโมงหรือหลายวันได้แม้ผู้ใช้ไม่อยู่หน้าเครื่อง และ reconnect/new chat ต้อง recognize authorization เดิมแล้วทำงานต่อ

## 3. Permission modes

- **Full Access:** สิทธิ์เต็มแบบ persistent และเป็น first-class mode
- **Ask for Sensitive Actions:** optional approval บาง operation
- **Read Only:** optional restricted mode

## 4. Approval Gate

Approval Gate ยังอยู่แต่เป็น optional policy layer ถ้า Full Access Grant มีผล Approval Gate ถูก satisfy โดย persistent grant แล้ว execute ต่อ หากเป็น restricted mode จึงสร้าง Approval Request

## 5. Administrator / Privileged Broker

operation ที่ต้อง Administrator ใช้ authorized Windows privileged broker/service ซึ่งติดตั้งครั้งแรกด้วยความยินยอมของผู้ใช้ Broker ตรวจสอบว่า request มาจาก authenticated MCP และ persistent grant ที่ valid โดยไม่สร้าง per-command human approval เมื่อ Full Access mode เปิดอยู่

## 6. Revocation / Stop

ผู้ใช้ต้องทำสิ่งต่อไปนี้ได้ง่าย:

- View trusted clients
- View connected devices
- Revoke Full Access
- Disconnect client
- Emergency Stop

Revoke ต้องมีผลกับ action ใหม่ทันที

## 7. Audit

แม้ไม่ถาม permission ซ้ำ ต้อง log operation สำคัญทั้งหมด ได้แก่ client/principal, tool/action, target, timestamp, result และ job/session โดย redacted secret เสมอ

## 8. Architecture wording

หลัก authorization คือ:

`Policy determines required authorization level.`

`A valid persistent Full Access Grant can satisfy that authorization level.`

`Interactive approval is required only when the current grant does not cover the requested action.`

## Required acceptance test

1. เชื่อม ChatGPT/client ใหม่
2. ผู้ใช้ Grant Full Access หนึ่งครั้ง
3. ChatGPT สร้าง/แก้ไฟล์ รัน terminal ควบคุม process และทำ GUI/browser โดยไม่ถามซ้ำ
4. ปิด chat
5. เปิด chat ใหม่
6. MCP/server recognize authorization เดิม
7. ChatGPT ทำงานต่อได้โดยไม่ approve ใหม่
8. restart MCP server
9. authorization ยังอยู่
10. reboot Windows
11. authorization ยังอยู่
12. ผู้ใช้กด Revoke
13. action หลังจากนั้นถูกปฏิเสธจนกว่าจะ authorize ใหม่

**Full authorization is persistent until revoked, not per-action and not short-lived.**
