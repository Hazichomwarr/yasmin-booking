-- Customer email is optional for public bookings. Existing email values,
-- customer identities, appointments, payments, and indexes are preserved.
ALTER TABLE "Customer" ALTER COLUMN "email" DROP NOT NULL;
