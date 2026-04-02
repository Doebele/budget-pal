import React from 'react';
import { Button } from '@shadcn/ui';

export const AccountActions = ({ 
  account, 
  onCreate, 
  onEdit, 
  onDelete 
}) => {
  return (
    <div className="flex gap-2 w-full">
      <Button onClick={onCreate} variant="outline" size="sm">
        + Neues Konto erstellen
      </Button>
      {account && (
        <>
          <Button 
            onClick={() => onEdit(account.id)} 
            variant="default"
            className="bg-green-600 hover:bg-green-700"
          >
            ✏️ Bearbeiten
          </Button>
          <Button 
            onClick={() => onDelete(account.id)}
            variant="destructive"
            size="sm"
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            🗑️ Löschen
          </Button>
        </>
      )}
    </div>
  );
};