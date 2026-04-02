import React from 'react';
import { Dialog, DialogPanel } from '@headlessui/react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Button } from '@shadcn/ui';

export function ConfirmDeleteModal({ 
  isOpen, 
  onClose, 
  onConfirmDelete, 
  accountName 
}) {
  if (!isOpen) return null;
  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/60" aria-hidden="true" />
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-sm overflow-hidden rounded-lg bg-slate-800 border border-slate-700">
          <DialogPanel className="relative px-6 py-4">
            <div className="flex items-center gap-3">
              <ExclamationTriangleIcon className="h-12 w-12 text-yellow-500" />
              <h3 className="text-lg font-semibold leading-6 text-white">
                Konto löschen?
              </h3>
            </div>
            <div className="mt-4 flex flex-col gap-2 text-slate-300">
              <p>
                "Account '{accountName}' wird nach Bestätigung dauerhaft gelöscht."
              </p>
              <p className="text-sm text-slate-500">
                Diese Aktion kann nicht rückgängig gemacht werden!
              </p>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button 
                onClick={onClose} 
                variant="secondary"
                className="bg-slate-700 hover:bg-slate-600 text-white"
              >
                Abbrechen
              </Button>
              <Button 
                onClick={() => { onConfirmDelete(); onClose(); }} 
                variant="destructive"
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                Konto wirklich löschen?
              </Button>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}