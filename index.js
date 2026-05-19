const express = require('express')
const cors = require('cors')
require('dotenv').config();
const crypto = require('crypto');
const app = express();
const port = process.env.PORT || 3000;
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = process.env.MONGO_URL;
const admin = require("firebase-admin");
// const serviceAccount = require("./zap-shift-01-firebase-adminsdk.json"); 

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


// middlewear
app.use(express.json());
app.use(cors({
  origin: [
    'https://zap-shift-01-client.onrender.com'
  ],
  credentials: true
}));

const verifyFBToken = async (req, res, next) => {

    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).send({ message: 'unauthorized access!' });
    }

    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        req.decoded_email = decoded.email;
        next();
    } catch (error) {
        return res.status(401).send({ message: 'unauthorized access!' });
    }
}

function generateTrackingId() {
    const prefix = "PRCL"; // your brand prefix
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
    const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

    return `${prefix}-${date}-${random}`;
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();
        const db = client.db('zap_shift_01_db');
        const usersCollection = db.collection('users');
        const parcelsCollection = db.collection('parcels');
        const paymentCollection = db.collection('payments');
        const ridersCollection = db.collection('riders');
        const trackingsCollection = db.collection('trackings');

        // 🔥 ADD THIS HERE
        await paymentCollection.createIndex(
            { transactionId: 1 },
            { unique: true }
        );

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await usersCollection.findOne(query);

            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'Forbidden access' });
            }
            next();
        }
        const verifyRider = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await usersCollection.findOne(query);

            if (!user || user.role !== 'rider') {
                return res.status(403).send({ message: 'Forbidden access' });
            }
            next();
        }

        const logTracking = async (trackingId, status) => {
            const log = {
                trackingId,
                status,
                details: status.split('_').join(' '),
                createdAt: new Date()
            }
            const result = await trackingsCollection.insertOne(log);
            return result;
        }
        // users api
        app.get('/users', verifyFBToken, async (req, res) => {
            const searchText = req.query.searchText;
            const query = {};
            if (searchText) {
                query.$or = [
                    { displayName: { $regex: searchText, $options: 'i' } },
                    { email: { $regex: searchText, $options: 'i' } }
                ]
            }

            const cursor = usersCollection.find(query).sort({ createdAt: -1 }).limit(10);
            const result = await cursor.toArray();
            res.send(result);
        })

        app.get('/users/:email/role', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            res.send({ role: user?.role || 'user' });
        })

        app.post('/users', async (req, res) => {
            const user = req.body;
            user.role = 'user';
            user.createdAt = new Date();
            const email = user.email;
            const userExist = await usersCollection.findOne({ email });

            if (userExist) {
                return res.send({ message: 'user already exist' });
            }

            const result = await usersCollection.insertOne(user);
            res.send(result);
        })

        app.patch('/users/role/:id', verifyFBToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const roleInfo = req.body.role;

            const query = { _id: new ObjectId(id) };
            const update = {
                $set: {
                    role: roleInfo
                }
            }
            const result = await usersCollection.updateOne(query, update);
            res.send(result);
        })

        // parcels api
        app.get('/parcels', async (req, res) => {
            const query = {};

            const { email, deliveryStatus } = req.query;

            if (email) {
                query.senderEmail = email
            }
            if (deliveryStatus) {
                query.deliveryStatus = deliveryStatus
            }
            const cursor = parcelsCollection.find(query).sort({ createdAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        })

        app.get('/parcels/delivery-status/status', async (req, res) => {
            const pipline = [
                {
                    $match: {
                        deliveryStatus: { $ne: null }
                    }
                },
                {
                    $group: {
                        _id: '$deliveryStatus',
                        count: { $sum: 1 }
                    }
                }
            ]
            const result = await parcelsCollection.aggregate(pipline).toArray();
            res.send(result);
        })

        app.get('/parcels/rider', async (req, res) => {
            const { riderEmail, deliveryStatus } = req.query;
            console.log(req.query);
            const query = {};
            if (riderEmail) {
                query.riderEmail = riderEmail
            }
            if (deliveryStatus !== 'parcel_delivered') {
                // query.deliveryStatus = {$in: ['driver_assigned', "driver_arriving"]}
                query.deliveryStatus = { $nin: ["parcel_delivered"] }
            }
            else {
                query.deliveryStatus = deliveryStatus
            }
            console.log(query);
            const cursor = parcelsCollection.find(query)
            const result = await cursor.toArray();
            res.send(result);
        })

        // Parcel by Id
        app.get('/parcels/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            const result = await parcelsCollection.findOne(query);
            res.send(result);
        })

        app.post('/parcels', async (req, res) => {
            const parcel = req.body;
            const trackingId = generateTrackingId();

            parcel.createdAt = new Date();
            parcel.trackingId = trackingId;

            logTracking(trackingId, 'parcel_created');
            const result = await parcelsCollection.insertOne(parcel);
            res.send(result);
        })

        app.patch('/parcels/:id', async (req, res) => {
            const { riderId, riderName, riderEmail, trackingId } = req.body;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            const update = {
                $set: {
                    deliveryStatus: 'driver_assigned',
                    riderId: riderId,
                    riderName: riderName,
                    riderEmail: riderEmail
                }
            }

            const result = await parcelsCollection.updateOne(query, update);

            // ridersCollection update
            const riderQuery = { _id: new ObjectId(riderId) };
            const riderUpdateDoc = {
                $set: {
                    workStats: 'in_delivery'
                }
            }
            const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdateDoc);

            // log tracking info
            logTracking(trackingId, 'driver_assigned');

            res.send(riderResult);
        })

        app.patch('/parcels/:id/status', async (req, res) => {
            const { deliveryStatus, riderId, trackingId } = req.body;
            const query = { _id: new ObjectId(req.params.id) };
            const update = {
                $set: {
                    deliveryStatus: deliveryStatus
                }
            }

            if (deliveryStatus === 'parcel_delivered') {
                const riderQuery = { _id: new ObjectId(riderId) };
                const riderUpdateDoc = {
                    $set: {
                        workStats: 'available'
                    }
                }
                const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdateDoc);
            }
            const result = await parcelsCollection.updateOne(query, update);

            // log tracking info
            logTracking(trackingId, deliveryStatus);
            res.send(result);
        })

        // parcel delete
        app.delete('/parcels/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }

            const result = await parcelsCollection.deleteOne(query);
            res.send(result);
        })

        // payment related api

        app.post('/create-checkout-session', async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost * 100);
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            unit_amount: amount,
                            product_data: {
                                name: paymentInfo.parcelName
                            }
                        },
                        quantity: 1,
                    },
                ],
                customer_email: paymentInfo.senderEmail,
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.parcelName,
                    trackingId: paymentInfo.trackingId
                },
                mode: 'payment',
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            })
            res.send({ url: session.url });
        })

        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);

            const transactionId = session.payment_intent;
            const query = { transactionId: transactionId }

            const paymentExist = await paymentCollection.findOne(query);

            if (paymentExist) {

                return res.send({
                    message: 'already exists',
                    transactionId,
                    trackingId: paymentExist.trackingId
                })
            }

            // use the previous tracking id created during the parcel create which was set to the session metadata during session creation
            const trackingId = session.metadata.trackingId;

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) }
                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        deliveryStatus: 'pending-pickup'
                    }
                }

                const result = await parcelsCollection.updateOne(query, update);

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId
                }
                const resultPayment = await paymentCollection.insertOne(payment);

                logTracking(trackingId, 'parcel_paid')

                return res.send({
                    success: true,
                    modifyParcel: result,
                    trackingId: trackingId,
                    transactionId: session.payment_intent,
                    paymentInfo: resultPayment
                })
            }
            return res.send({ success: false })
        })


        // app.patch('/payment-success', async (req, res) => {
        //     const sessionId = req.query.session_id;
        //     const session = await stripe.checkout.sessions.retrieve(sessionId);

        //     const transactionId = session.payment_intent;
        //     const query = { transactionId: transactionId }

        //     const paymentExist = await paymentCollection.findOne(query);

        //     if (paymentExist) {
        //         return res.send({
        //             message: 'already exists',
        //             transactionId,
        //             trackingId: paymentExist.trackingId
        //         })
        //     }


        //     const trackingId = generateTrackingId()

        //     if (session.payment_status === 'paid') {
        //         const id = session.metadata.parcelId;
        //         const query = { _id: new ObjectId(id) }
        //         const update = {
        //             $set: {
        //                 paymentStatus: 'paid',
        //                 deliveryStatus: 'pending-pickup',
        //                 trackingId: trackingId
        //             }
        //         }

        //         const result = await parcelsCollection.updateOne(query, update);

        //         const payment = {
        //             amount: session.amount_total / 100,
        //             currency: session.currency,
        //             customerEmail: session.customer_email,
        //             parcelId: session.metadata.parcelId,
        //             parcelName: session.metadata.parcelName,
        //             transactionId: session.payment_intent,
        //             paymentStatus: session.payment_status,
        //             paidAt: new Date(),
        //             trackingId: trackingId
        //         }

        //         // if (session.payment_status === 'paid') {
        //         //     const resultPayment = await paymentCollection.insertOne(payment)

        //         //     res.send({
        //         //         success: true,
        //         //         modifyParcel: result,
        //         //         trackingId: trackingId,
        //         //         transactionId: session.payment_intent,
        //         //         paymentInfo: resultPayment
        //         //     })
        //         // }
        //         let resultPayment;

        //         try {
        //             resultPayment = await paymentCollection.insertOne(payment);

        //             // log tracking info
        //             logTracking(trackingId, 'pending-pickup')

        //         } catch (error) {
        //             if (error.code === 11000) {
        //                 return res.send({
        //                     message: "duplicate payment blocked",
        //                     success: false
        //                 });
        //             }

        //             throw error;
        //         }

        //         return res.send({
        //             success: true,
        //             modifyParcel: result,
        //             trackingId: trackingId,
        //             transactionId: session.payment_intent,
        //             paymentInfo: resultPayment
        //         });

        //     }

        //     res.send({ success: false })
        // })

        app.get('/payments', verifyFBToken, async (req, res) => {
            const email = req.query.email;
            const query = {};

            if (email) {
                query.customerEmail = email;

                if (email !== req.decoded_email) {
                    return res.status(403).send({ message: "Forbidden access" })
                }
            }



            const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        })

        // riders related api
        app.get('/riders', async (req, res) => {
            const { status, workStats, district } = req.query;
            const query = {};
            if (status) {
                query.status = status
            }
            if (workStats) {
                query.workStats = workStats
            }
            if (district) {
                query.district = district
            }

            const cursor = ridersCollection.find(query)
            const result = await cursor.toArray();
            res.send(result);
        })

        app.get('/riders/delivery-per-day', async (req, res) => {
            const email = req.query.riderEmail;
            const pipeline = [
                {
                    $match: {
                        riderEmail: email,
                        deliveryStatus: "parcel_delivered"
                    }
                },
                {
                    $lookup: {
                        from: "trackings",
                        localField: "trackingId",
                        foreignField: "trackingId",
                        as: "parcel_trackings"
                    }
                },
                {
                    $unwind: "$parcel_trackings"
                },
                {
                    $match: {
                        "parcel_trackings.status": "parcel_delivered"
                    }
                },
                {
                    $addFields: {
                        deliveryDay: {
                            $dateToString: {
                                format: "%Y-%m-%d",
                                date: "$parcel_trackings.createdAt"
                            }
                        }
                    }
                },
                {
                    $group: {
                        _id: "$deliveryDay",
                        deliveredCount: { $sum: 1 }
                    }
                }
            ];
 
            const result = await parcelsCollection.aggregate(pipeline).toArray();
            res.send(result);
        })

        app.post('/riders', async (req, res) => {
            const rider = req.body;
            rider.status = 'pending';
            rider.createdAt = new Date();

            const result = await ridersCollection.insertOne(rider);
            res.send(result);
        })

        app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
            const status = req.body.status;
            const id = req.params.id;

            const query = { _id: new ObjectId(id) }
            const update = {
                $set: {
                    status: status,
                    workStats: 'available'
                }
            }
            const result = await ridersCollection.updateOne(query, update)

            if (status === 'approved') {
                const email = req.body.email;
                const userQuery = { email }
                const updateUser = {
                    $set: {
                        role: 'rider'
                    }
                }
                const userResult = await usersCollection.updateOne(userQuery, updateUser)
            }

            res.send(result);
        });

        app.delete('/riders/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }

            const result = await ridersCollection.deleteOne(query)
            res.send(result);
        })


        // log tracking info
        app.get('/trackings/:trackingId/logs', async (req, res) => {
            const trackingId = req.params.trackingId;
            const query = { trackingId };
            const result = await trackingsCollection.find(query).toArray();
            res.send(result);
        })

        // Send a ping to confirm a successful connection
        // await client.db("admin").command({ ping: 1 });
        // console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('Zap Shift server is on')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})