import { db } from '@/lib/db';
import { UpdateAccountDto } from '@/types';

async function updateAccount(id: number, data: UpdateAccountDto) {
  const existingAccount = await db.Account.findUnique({ where: { id } });
  if (!existingAccount) throw new Error('Konto existiert nicht');
  return await db.Account.update({
    where: { id },
    data
  });
}

async function deleteAccountById(id: number): Promise<void> {
  await db.Account.update({
    where: { 
      id: id
    },
    data: { 
      isDeleted: true,
      deletedAt: new Date()
    }
  });
}

export { updateAccount, deleteAccountById };
