import { useState } from 'react';
import { db } from '@/lib/db';

export const useAccountManagement = () => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const editAccount = async (id: number, data: UpdateAccountDto) => {
    if (!accounts.find(a => a.id === id)) {
      throw new Error('Account existiert nicht');
    }
    const updated = await db.Account.update({
      where: { id },
      data: {
        name: data.name,
        balance: data.balance,
        currency: data.currency || 'CHF'
      }
    });
    return updated;
  };
  const deleteAccount = async (id: number) => {
    await db.Account.update({
      where: { id },
      data: { 
        isDeleted: true,
        deletedAt: new Date() 
      }
    });
    setAccounts(await db.Account.findMany());
  };
  return { editAccount, deleteAccount };
};