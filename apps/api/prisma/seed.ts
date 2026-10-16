import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const department = await prisma.department.upsert({ where: { code: 'CSE' }, update: {}, create: { code: 'CSE', name: 'Computer Science & Engineering' } });
  const passwordHash = await argon2.hash('ExamOps-Demo-2026!');
  await prisma.user.upsert({ where: { email: 'admin@examops.local' }, update: {}, create: { email: 'admin@examops.local', name: 'Aarav Sharma', passwordHash, role: 'ADMIN', departmentId: department.id } });
  await prisma.user.upsert({ where: { email: 'hod@examops.local' }, update: {}, create: { email: 'hod@examops.local', name: 'Dr. Meera Iyer', passwordHash, role: 'HOD', departmentId: department.id } });
  for (const [index, name] of ['Riya Patel', 'Kabir Singh', 'Ananya Rao'].entries()) {
    const email = `student${index + 1}@examops.local`;
    const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email, name, passwordHash, role: 'STUDENT', departmentId: department.id } });
    await prisma.studentProfile.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id, institutionalId: `CSE2026${String(index + 1).padStart(3, '0')}`, program: 'B.Tech Computer Science', year: 3 } });
  }
  for (const [code, name] of [['CS301', 'Distributed Systems'], ['CS302', 'Secure Software Engineering']]) await prisma.course.upsert({ where: { code }, update: {}, create: { code, name, departmentId: department.id } });
  for (const [code, name, courseCode] of [['CS301A', 'Distributed Systems', 'CS301'], ['CS302A', 'Secure Software Engineering', 'CS302']]) { const course = await prisma.course.findUniqueOrThrow({ where: { code: courseCode } }); await prisma.subject.upsert({ where: { code }, update: {}, create: { code, name, courseId: course.id, departmentId: department.id } }); }
  const rooms: Array<[string, number]> = [['A-101', 60], ['A-202', 45], ['B-105', 30]];
  for (const [code, capacity] of rooms) await prisma.examinationRoom.upsert({ where: { code }, update: {}, create: { code, building: 'Academic Block', capacity } });
  console.log('Seeded ExamOps demo data. Demo password is documented for development only.');
}
main().finally(() => prisma.$disconnect());
