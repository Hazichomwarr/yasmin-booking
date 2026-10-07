-- Appointment.appointment_date is a salon-local calendar date. The application
-- must store and query its YYYY-MM-DD value without applying timezone conversion.

CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO');
CREATE TYPE "AppointmentStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE');
CREATE TYPE "PaymentPurpose" AS ENUM ('BOOKING_DEPOSIT');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');
CREATE TYPE "AppointmentEventType" AS ENUM ('CREATED', 'PAYMENT_CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'COMPLETED', 'NO_SHOW', 'CUSTOMER_UPDATED', 'NOTE_UPDATED');

CREATE TABLE "SalonLocation" ("id" TEXT NOT NULL,"name" TEXT NOT NULL,"addressLine1" TEXT,"addressLine2" TEXT,"city" TEXT,"state" TEXT,"postalCode" TEXT,"phone" TEXT,"isActive" BOOLEAN NOT NULL DEFAULT true,"acceptsOnlineBooking" BOOLEAN NOT NULL DEFAULT false,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "SalonLocation_pkey" PRIMARY KEY ("id"));
CREATE TABLE "BookingSlot" ("id" TEXT NOT NULL,"locationId" TEXT NOT NULL,"localStartTime" TIME(0) NOT NULL,"capacity" INTEGER NOT NULL,"isActive" BOOLEAN NOT NULL DEFAULT true,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "BookingSlot_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Customer" ("id" TEXT NOT NULL,"name" TEXT NOT NULL,"email" TEXT NOT NULL,"phone" TEXT NOT NULL,"emailMarketingAt" TIMESTAMP(3),"smsMarketingAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "Customer_pkey" PRIMARY KEY ("id"));
CREATE TABLE "HairstyleCategory" ("id" TEXT NOT NULL,"name" TEXT NOT NULL,"slug" TEXT NOT NULL,"description" TEXT,"isActive" BOOLEAN NOT NULL DEFAULT true,"sortOrder" INTEGER NOT NULL DEFAULT 0,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "HairstyleCategory_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Hairstyle" ("id" TEXT NOT NULL,"categoryId" TEXT NOT NULL,"name" TEXT NOT NULL,"slug" TEXT NOT NULL,"description" TEXT,"isActive" BOOLEAN NOT NULL DEFAULT true,"sortOrder" INTEGER NOT NULL DEFAULT 0,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "Hairstyle_pkey" PRIMARY KEY ("id"));
CREATE TABLE "HairstyleMedia" ("id" TEXT NOT NULL,"hairstyleId" TEXT NOT NULL,"type" "MediaType" NOT NULL,"storageKey" TEXT NOT NULL,"deliveryUrl" TEXT,"altText" TEXT,"caption" TEXT,"sortOrder" INTEGER NOT NULL DEFAULT 0,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "HairstyleMedia_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Appointment" ("id" TEXT NOT NULL,"customerId" TEXT NOT NULL,"locationId" TEXT NOT NULL,"bookingSlotId" TEXT NOT NULL,"hairstyleId" TEXT,"appointmentDate" DATE NOT NULL,"status" "AppointmentStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',"preferredStylistName" TEXT,"customerNotes" TEXT,"holdExpiresAt" TIMESTAMP(3),"locationNameSnapshot" TEXT NOT NULL,"slotTimeSnapshot" TEXT NOT NULL,"hairstyleNameSnapshot" TEXT,"totalPriceCents" INTEGER NOT NULL,"depositAmountCents" INTEGER NOT NULL,"balanceDueCents" INTEGER NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Payment" ("id" TEXT NOT NULL,"appointmentId" TEXT NOT NULL,"provider" "PaymentProvider" NOT NULL,"purpose" "PaymentPurpose" NOT NULL,"status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',"amountCents" INTEGER NOT NULL,"currency" TEXT NOT NULL DEFAULT 'usd',"providerCheckoutSessionId" TEXT,"providerPaymentIntentId" TEXT,"paidAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "Payment_pkey" PRIMARY KEY ("id"));
CREATE TABLE "AppointmentEvent" ("id" TEXT NOT NULL,"appointmentId" TEXT NOT NULL,"type" "AppointmentEventType" NOT NULL,"details" JSONB,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "AppointmentEvent_pkey" PRIMARY KEY ("id"));
CREATE TABLE "AdminUser" ("id" TEXT NOT NULL,"email" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id"));

CREATE UNIQUE INDEX "BookingSlot_locationId_localStartTime_key" ON "BookingSlot"("locationId","localStartTime");
CREATE UNIQUE INDEX "HairstyleCategory_slug_key" ON "HairstyleCategory"("slug");
CREATE UNIQUE INDEX "Hairstyle_slug_key" ON "Hairstyle"("slug");
CREATE UNIQUE INDEX "HairstyleMedia_storageKey_key" ON "HairstyleMedia"("storageKey");
CREATE UNIQUE INDEX "Payment_providerCheckoutSessionId_key" ON "Payment"("providerCheckoutSessionId");
CREATE UNIQUE INDEX "Payment_providerPaymentIntentId_key" ON "Payment"("providerPaymentIntentId");
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");
CREATE INDEX "SalonLocation_isActive_idx" ON "SalonLocation"("isActive");
CREATE INDEX "SalonLocation_acceptsOnlineBooking_idx" ON "SalonLocation"("acceptsOnlineBooking");
CREATE INDEX "BookingSlot_locationId_isActive_idx" ON "BookingSlot"("locationId","isActive");
CREATE INDEX "Customer_email_idx" ON "Customer"("email");
CREATE INDEX "Customer_phone_idx" ON "Customer"("phone");
CREATE INDEX "HairstyleCategory_isActive_sortOrder_idx" ON "HairstyleCategory"("isActive","sortOrder");
CREATE INDEX "Hairstyle_categoryId_isActive_sortOrder_idx" ON "Hairstyle"("categoryId","isActive","sortOrder");
CREATE INDEX "HairstyleMedia_hairstyleId_type_sortOrder_idx" ON "HairstyleMedia"("hairstyleId","type","sortOrder");
CREATE INDEX "Appointment_appointmentDate_status_idx" ON "Appointment"("appointmentDate","status");
CREATE INDEX "Appointment_locationId_appointmentDate_bookingSlotId_idx" ON "Appointment"("locationId","appointmentDate","bookingSlotId");
CREATE INDEX "Appointment_customerId_idx" ON "Appointment"("customerId");
CREATE INDEX "Appointment_holdExpiresAt_idx" ON "Appointment"("holdExpiresAt");
CREATE INDEX "Payment_appointmentId_idx" ON "Payment"("appointmentId");
CREATE INDEX "Payment_status_idx" ON "Payment"("status");
CREATE INDEX "AppointmentEvent_appointmentId_createdAt_idx" ON "AppointmentEvent"("appointmentId","createdAt");

ALTER TABLE "BookingSlot" ADD CONSTRAINT "BookingSlot_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "SalonLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Hairstyle" ADD CONSTRAINT "Hairstyle_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "HairstyleCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HairstyleMedia" ADD CONSTRAINT "HairstyleMedia_hairstyleId_fkey" FOREIGN KEY ("hairstyleId") REFERENCES "Hairstyle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "SalonLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_bookingSlotId_fkey" FOREIGN KEY ("bookingSlotId") REFERENCES "BookingSlot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_hairstyleId_fkey" FOREIGN KEY ("hairstyleId") REFERENCES "Hairstyle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
