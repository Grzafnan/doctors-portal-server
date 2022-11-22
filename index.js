const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const port = process.env.PORT || 5000
require('dotenv').config()
const jwt = require('jsonwebtoken');
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY)

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

const uri = process.env.URI;
// const uri = 'mongodb://localhost:27017/';
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });


function verifyJWT(req, res, next) {
  // console.log(req);
  const userJwtToken = req.headers.authorization;

  if (!userJwtToken) {
    return res.status(401).send({
      success: false,
      message: "Unauthorized access."
    })
  }

  const token = userJwtToken.split(' ')[1];
  jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
    if (err) {
      return res.status(403).send({
        success: false,
        message: 'Forbidden access.'
      })
    }
    req.decoded = decoded;
    next();
  })
};


async function run() {
  try {
    await client.connect();
    console.log('Server connected');
  } catch (error) {
    console.log(error.message);
  }
}
run();

const AppointmentOptions = client.db('doctors-portal').collection('appointment-options');
const Bookings = client.db('doctors-portal').collection('bookings');
const Users = client.db('doctors-portal').collection('users');
const Doctors = client.db('doctors-portal').collection('doctors');
const Payments = client.db('doctors-portal').collection('payments');


// NOTE: make sure you use verifyAdmin after verifyJWT

const verifyAdmin = async (req, res, next) => {
  const decodedEmail = req.decoded.email;
  const user = await Users.findOne({ email: decodedEmail })
  if (user?.role !== "Admin") {
    res.status(403).send({
      success: false,
      message: "Unauthorized access."
    })
  }
  next();
}



// Use Aggregate to query multiple collection and then merge data
app.get('/appointment-options', async (req, res) => {
  const date = req.query.date;
  try {
    const appointmentOptions = await AppointmentOptions.find({}).toArray();
    // console.log(date);

    // get the bookings of the provided date
    const bookingQuery = { appointmentDate: date }
    const allreadyBooked = await Bookings.find(bookingQuery).toArray();

    // code carefully :D
    appointmentOptions.forEach(option => {
      const optionBooked = allreadyBooked.filter(book => book.treatmentName === option.name);
      const bookedSlots = optionBooked.map(book => book.appointmentTime);
      // console.log(bookedSlots);
      const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot))
      option.slots = remainingSlots;

      // console.log(remainingSlots);
      // console.log(option.treatmentName, bookedSlots);
    })

    res.send({
      success: true,
      data: appointmentOptions
    })
  } catch (error) {
    console.log(error.name, error.message);
    res.send({
      success: false,
      error: error.message
    })
  }
})



app.get('/appointment-specialty', async (req, res) => {
  try {
    const result = await AppointmentOptions.find({}).project({ name: 1 }).toArray();
    res.send({
      success: true,
      data: result
    })
  } catch (error) {
    console.log(error);
    res.send({
      success: false,
      error: error.message
    })
  }
})



app.get('/v2/appointment-options', async (req, res) => {
  const date = req.query.date;
  const options = await AppointmentOptions.aggregate([
    {
      $lookup: {
        from: 'bookings',
        localField: 'name',
        foreignField: 'treatmentName',
        pipeline: [
          {
            $match: {
              $expr: {
                $eq: ['$appointmentDate', date]
              }
            }
          }
        ],
        as: 'booked'
      }
    },
    {
      $project: {
        name: 1,
        price: 1,
        slots: 1,
        booked: {
          $map: {
            input: '$booked',
            as: 'book',
            in: '$$book.appointmentTime'
          }
        }
      }
    },
    {
      $project: {
        name: 1,
        price: 1,
        slots: {
          $setDifference: ['$slots', '$booked']
        }
      }
    }
  ]).toArray();

  res.send({
    success: true,
    data: options
  });
})


app.get('/bookings', verifyJWT, async (req, res) => {
  try {
    if (req.query.email !== req.decoded.email) {
      return res.status(403).send({ success: false, message: 'Forbidden access' });
    }
    const result = await Bookings.find({ email: req.query.email }).toArray();
    res.send({
      success: true,
      data: result
    })

  } catch (error) {
    console.log(error);
    res.send({
      success: false,
      error: error.message
    })
  }
})


//  Get specific Booking 

app.get('/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await Bookings.findOne({ _id: ObjectId(id) })
    res.send({
      success: true,
      data: booking
    })
  } catch (error) {
    console.log(error);
    res.send({
      success: false,
      error: error.message
    })
  }
})

//Bookings API
app.post('/bookings', async (req, res) => {
  try {
    const booking = req.body;
    const query = {
      appointmentDate: booking.appointmentDate,
      email: booking.email,
      treatmentName: booking.treatmentName
    }

    const allReadyBooked = await Bookings.find(query).toArray();

    if (allReadyBooked.length) {
      const message = `You already have a booking on ${booking.appointmentDate}`
      res.send({ success: false, message })
      return;
    }

    const result = await Bookings.insertOne(booking);


    res.send({
      success: true,
      data: result
    })
  } catch (error) {
    console.log(error.name, error.message);
    res.send({
      success: false,
      error: error.message
    })
  }
})


//Payment Intent
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { price } = req.body;
    const amount = Number(price * 100);
    // Create a PaymentIntent with the order amount and currency
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: "usd",
      "payment_method_types": [
        "card"
      ],
    });

    res.send({
      success: true,
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.log(error.name, error.message);
    res.send({
      success: false,
      error: error.message
    })
  }
});

// Save payment information
app.post('/payments', async (req, res) => {
  try {
    const payment = req.body;
    const result = await Payments.insertOne(payment);

    const id = payment.bookingId;
    const filter = { _id: ObjectId(id) }
    const updateDoc = {
      $set: {
        paid: true,
        transactionId: payment.transactionId,
      }
    }

    const udpdatedResult = await Bookings.updateOne(filter, updateDoc)

    res.send({
      success: true,
      data: result
    })
  } catch (error) {
    console.log(error);
    res.send({
      success: false,
      error: error.message
    })
  }
})


//Saved user in DB
app.post('/users', async (req, res) => {
  try {
    const isUserExists = await Users.findOne({ email: req.body.user.email })

    if (isUserExists) {
      return res.send({
        success: false,
        message: 'User already exists'
      })
    }

    const user = await Users.insertOne(req.body.user);
    res.send({
      success: true,
      data: user
    })
  } catch (error) {
    console.log(error);
    res.send({
      success: false,
      error: error.message
    })
  }
})


app.get('/jwt', async (req, res) => {
  const email = req.query.email;
  const user = await Users.findOne({ email: email });
  if (user) {
    const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '1d' })
    return res.send({
      success: true,
      token: token
    })
  }
  res.status(403).send({
    token: 'Unauthorized access'
  })
});


//All users
app.get('/users', async (req, res) => {
  try {
    const users = await Users.find({}).toArray();
    res.send({
      success: true,
      data: users
    })
  } catch (error) {
    console.log(error);
    res.send({
      success: false,
      error: error.message
    })
  }
})


// Get Admin 

app.get('/users/admin/:email', async (req, res) => {
  const { email } = req.params;
  const user = await Users.findOne({ email })
  res.send({ isAdmin: user?.role === 'Admin' })
})


// Make Admin
app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const filter = { _id: ObjectId(id) }
    const options = { upsert: true };
    const updateDoc = {
      $set: {
        role: 'Admin'
      }
    }

    const result = await Users.updateOne(filter, updateDoc, options)
    res.send({
      success: true,
      data: result
    })
  } catch (error) {
    console.log(error);
    res.send({
      success: false,
      error: error.message
    });
  }
})


// temporary to update price field on appointment options
// app.get('/addPrice', async (req, res) => {
//   const filter = {}
//   const options = { upsert: true }
//   const doc = {
//     $set: {
//       price: 99
//     }
//   }
//   const result = await AppointmentOptions.updateMany(filter, doc, options)
//   res.send(result)
// })




// delete user by admin 
app.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await Users.deleteOne({ _id: ObjectId(id) });
    res.send({
      success: true,
      result: user
    })
  } catch (error) {
    console.log(error.name, error.message);
    res.send({
      success: false,
      error: error.message
    })
  }
})


// get doctors
app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const result = await Doctors.find({}).toArray();
    res.send({
      success: true,
      data: result
    })
  } catch (error) {
    console.log(error);
    res.send({
      success: false,
      error: error.message
    })
  }
})

// Insert Doctor data
app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const result = await Doctors.insertOne(req.body);
    res.send({
      success: true,
      data: result
    })
  } catch (error) {
    console.log(error.name, error.message);
    res.send({
      success: false,
      error: error.message
    })
  }
});

// delete user by admin 
app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const doctor = await Doctors.deleteOne({ _id: ObjectId(id) });
    res.send({
      success: true,
      result: doctor
    })
  } catch (error) {
    console.log(error.name, error.message);
    res.send({
      success: false,
      error: error.message
    })
  }
})



app.get('/', (req, res) => {
  res.send('Doctors portal server is running')
})

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
})